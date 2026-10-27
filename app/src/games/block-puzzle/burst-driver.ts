import { BlockPuzzleChain, type ChainSigner } from "./chain";
import { sessionFromTable, type BurstSession } from "@/lib/chain/burst-read";
import { matchAddressOf } from "@/lib/chain/match-id";
import { matchProgress } from "@/lib/chain/match-progress";
import { isCancelling } from "@/lib/chain/match-status";
import type { ChainMatch } from "@/lib/chain/read";
import { commitPhase, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { plainError } from "@/lib/errors";
import {
  TABLE_PHASE,
  FREEZE_OFFSET_SLOTS,
  paceLimit,
  phaseAt,
  runLogOf,
  tableOf,
  type Assignment,
  type BlockBurstChain,
  type OwnBoard,
  type PlayerSigner,
  type Table,
} from "./live-chain";
import { mergeClock, runRemainingMs, sampleClock, slotNow, type SlotClock } from "./live-clock";
import { MIN_GAP_MS, nextStep, type Step } from "./live-driver";
import { resumeState } from "./resume";
import { BurstSubmitter } from "./burst-submitter";
import { acquireSubmitterLock, type SubmitterLock } from "./submitter-lock";
import type { MatchRun } from "./BlockPuzzleGame";

/** Where a Block Burst Match is in its life, read from the chain and the rollup's clock. */
export type Stage =
  | "loading"
  | "notfound"
  | "spectator"
  /** You fund a Player's side and do not play it. */
  | "backer"
  /** Open: nobody has joined. */
  | "waiting"
  /** Joined: no table has been chosen yet. */
  | "table"
  | "cancelling"
  /** At the table: seating, check-in, the Seed. */
  | "setup"
  /** The Seed is in; the run starts on the clock. */
  | "getReady"
  | "playing"
  /** The window is over; the result is being written, committed and paid. */
  | "closing"
  | "settled";

export interface BurstView {
  stage: Stage;
  match: ChainMatch | null;
  seat: 0 | 1 | null;
  assignment: Assignment | null;
  /** The public table from the rollup (the committed one once the Match is settled). */
  table: Table | null;
  /** The rollup's slot clock; the screen's timers are the table's `start_slot` measured against it. */
  clock: SlotClock | null;
  /** The live run, once it has begun and this tab is the one that sends the moves. */
  run: MatchRun | null;
  /** Another tab of this browser is playing this Match for you. */
  elsewhere: boolean;
  /** Your run ended before the clock did. */
  ownOver: boolean;
  /** Why the Match ended (`REASON`), once known. */
  reason: number | null;
  /** The scores and Seed of the finished Match, while the table still holds them. */
  result: BurstSession | null;
  note: string;
  error: string | null;
  sigs: { label: string; sig: string; layer: "base" | "tee" }[];
  /** The tesoro_core refund deadline passed on an unfinished Match. */
  refundable: boolean;
  commit: CommitState | null;
  /** Reads of the table keep failing: what is shown may be behind. */
  reconnecting: boolean;
}

export const initialBurstView = (): BurstView => ({
  stage: "loading",
  match: null,
  seat: null,
  assignment: null,
  table: null,
  clock: null,
  run: null,
  elsewhere: false,
  ownOver: false,
  reason: null,
  result: null,
  note: "",
  error: null,
  sigs: [],
  refundable: false,
  commit: null,
  reconnecting: false,
});

/** The stage a Player sees for an assigned Match, from the table the rollup holds. */
export function tableStage(i: { hasTable: boolean; running: boolean; phase: string | null; closed: boolean; began: boolean }): Stage {
  if (!i.hasTable) return "table";
  const live = i.phase === "running" || i.phase === "frozen" || i.phase === "grace";
  if (i.running || (live && i.began)) return "playing";
  if (i.phase === "getReady" || live) return "getReady";
  return i.phase === "ended" || i.closed ? "closing" : "setup";
}

const errText = plainError;
const now = () => Date.now();

/** The facts about a table that decide the driver's next step; unchanged for a while means the keeper is not moving it. */
const stateKey = (t: Table | null, a: Assignment | null) =>
  t ? [a?.epoch, t.epoch, t.phase, t.seatsOpen, t.checkedIn.join(), t.seedReady, t.reqPending, t.reqCount, t.startSlot, t.dirty].join("|") : "none";

const SLOT_EVERY_MS = 2_000;
const TICK_MS = 1_000;

export interface BurstDriverDeps {
  id: string;
  signer: ChainSigner;
  /** The Player's Account key (the submitter lock is per Account). */
  accountKey: string | null;
  chain: BlockBurstChain;
  fetchMatch(id: string, me: ReturnType<typeof BlockPuzzleChain.coreAccount>): Promise<ChainMatch | null>;
  /** Called once when the Match is seen settled or refunded. */
  onSettled?(): void;
  /** Every send, for the page's receipts and the timing script. */
  onTx?(label: string, layer: "base" | "tee", sig: string): void;
}

/**
 * Drives one Block Burst Match for one Player, without a screen: the page (`useBurstMatch`) and the timing script both run
 * this. The keeper does the steps anyone may do; this does them when the table has not moved for a few seconds, so a Match
 * never waits on the keeper. Every step re-reads chain state, and a lost race is harmless.
 */
export class BurstDriver {
  view: BurstView = initialBurstView();
  private readonly listeners = new Set<(v: BurstView) => void>();
  private readonly mk: ReturnType<typeof matchAddressOf>;
  private readonly progress;

  private working = false;
  private assign: Assignment | null = null;
  private tableRef: Table | null = null;
  private tableAt = 0;
  private baseRef: Table | null = null;
  private clockRef: SlotClock | null = null;
  private boardRef: OwnBoard | null = null;
  private matchRef: ChainMatch | null = null;
  private matchAt = 0;
  private keyRef = { key: "", since: 0 };
  private lastTry: Partial<Record<Step["kind"], number>> = {};
  private submitter: BurstSubmitter | null = null;
  private lock: SubmitterLock | null = null;
  private beginning = false;
  private settledSeen = false;
  private closingSince = 0;
  private commitSince = 0;
  private failures = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopFeed: (() => void) | null = null;
  private watchedFor = "";
  private stopped = false;

  constructor(private d: BurstDriverDeps) {
    this.mk = matchAddressOf(d.id);
    this.progress = matchProgress<ChainMatch, Stage>(d.id);
  }

  private get p(): PlayerSigner {
    return this.d.signer as unknown as PlayerSigner;
  }

  /** The page re-renders with a new signer object or callback for the same Match and wallet: later sends use them. */
  update(next: Partial<Pick<BurstDriverDeps, "signer" | "accountKey" | "onSettled">>) {
    this.d = { ...this.d, ...next };
  }

  // -- view ------------------------------------------------------------------------------------------

  /** For `useSyncExternalStore`: stable functions, and a view that is replaced (never mutated) on every change. */
  readonly subscribe = (fn: (v: BurstView) => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly snapshot = (): BurstView => this.view;

  private set(fn: (v: BurstView) => BurstView) {
    const next = fn(this.view);
    if (next === this.view) return;
    this.view = next;
    for (const l of this.listeners) l(next);
  }

  private patch(p: Partial<BurstView>) {
    this.set((v) => ({ ...v, ...p }));
  }

  private patchStage(stage: Stage, p: Partial<BurstView> = {}) {
    this.patch({ ...p, stage: this.progress.stage(stage).stage });
  }

  private addSig(label: string, sig: string | undefined, layer: "base" | "tee") {
    if (sig) this.set((v) => (v.sigs.some((x) => x.sig === sig) ? v : { ...v, sigs: [...v.sigs, { label, sig, layer }] }));
  }

  // -- lifecycle -------------------------------------------------------------------------------------

  start() {
    this.stopped = false;
    const chain = this.d.chain;
    // The moves are not receipts (there are dozens); `close` shares its name with Trading Duel's, so it is named for its table.
    chain.onTx = (label, layer, sig) => {
      this.d.onTx?.(label, layer, sig);
      if (label !== "play" && label !== "play_hidden") this.addSig(label === "close" ? "close_table" : label, sig, layer);
    };
    this.timers.push(setInterval(() => void this.readClock(), SLOT_EVERY_MS));
    void this.readClock();
    setTimeout(() => void this.tick(), 0);
    this.timers.push(setInterval(() => void this.tick(), TICK_MS));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopFeed?.();
    this.stopFeed = null;
    this.d.chain.onTx = undefined;
    this.submitter?.stop();
    this.lock?.release();
  }

  // -- the clock: the rollup's slot, read every 2 s and run forward in between ------------------------

  private async readClock() {
    if (this.stopped || !this.assign) return;
    try {
      const at = performance.now();
      const slot = await this.d.chain.currentSlot(this.p);
      if (this.stopped) return;
      this.clockRef = mergeClock(this.clockRef, sampleClock(slot, at));
      this.set((v) => (v.clock === this.clockRef ? v : { ...v, clock: this.clockRef, reconnecting: false }));
    } catch {
      this.set((v) => (v.reconnecting ? v : { ...v, reconnecting: true }));
    }
  }

  // -- the table: websocket with a polling fallback --------------------------------------------------

  private watch(a: Assignment) {
    const key = a.address.toBase58();
    if (this.watchedFor === key) return;
    this.watchedFor = key;
    void this.d.chain
      .watchTable(
        this.p,
        a,
        (t) => {
          if (!tableOf(a, t)) return;
          this.tableRef = t;
          this.tableAt = now();
          this.set((v) => ({ ...v, table: t, reconnecting: false }));
        },
        () => this.set((v) => (v.reconnecting ? v : { ...v, reconnecting: true })),
      )
      .then((stop) => {
        if (this.stopped) stop();
        else this.stopFeed = stop;
      })
      .catch(() => undefined);
  }

  // -- the driver ------------------------------------------------------------------------------------

  private async startRun(a: Assignment, t: Table, seat: 0 | 1, board: OwnBoard) {
    if (this.submitter || this.beginning) return;
    this.beginning = true;
    try {
      const l = await acquireSubmitterLock(this.d.id, this.d.accountKey ?? this.p.publicKey.toBase58());
      this.lock = l;
      if (!l.held) {
        this.patch({ elsewhere: true });
        return;
      }
      const chain = this.d.chain;
      const startCount = board.moves;
      // The reconnect: the Seed and the move log rebuild the run exactly as the chain holds it.
      const resume = resumeState(board);
      const sub = new BurstSubmitter(
        {
          send: (moves, expected, hidden, beat) => chain.play(this.p, this.tableRef ?? t, seat, expected, moves, hidden, beat),
          movesOnChain: async () => (await chain.readOwnBoard(this.p, a, seat).catch(() => null))?.moves ?? null,
          slot: () => (this.clockRef ? slotNow(this.clockRef, performance.now()) : 0),
          paceLimit: (slot) => paceLimit(this.tableRef ?? t, slot),
        },
        { startCount, freezeSlot: t.startSlot + FREEZE_OFFSET_SLOTS },
      );
      this.submitter = sub;
      const run: MatchRun = {
        seed: board.seed,
        entry: this.matchRef?.entry ?? 0,
        resume: startCount > 0 ? resume : undefined,
        remainingMs: () => (this.tableRef && this.clockRef ? runRemainingMs(this.tableRef, this.clockRef, performance.now()) : 0),
        onMove: (m) => sub.push(m),
        onEnd: () => {
          this.patch({ ownOver: true });
          void sub.finish().then(() => {
            if (sub.error) this.patch({ error: `Some moves were not accepted: ${errText(sub.error)}` });
          });
        },
      };
      this.patch({ run, elsewhere: false });
    } finally {
      this.beginning = false;
    }
  }

  private async settle(m: ChainMatch) {
    if (this.settledSeen) return;
    this.settledSeen = true;
    this.submitter?.stop();
    this.submitter = null;
    this.lock?.release();
    setCommitPending(m.id, false);
    this.d.onSettled?.();
  }

  private async step() {
    const { chain, signer, id } = this.d;
    const p = this.p;
    const mk = this.mk;
    if (mk === null) return;
    const me = BlockPuzzleChain.coreAccount(signer.publicKey);
    if (!this.matchRef || now() - this.matchAt > 2_500 || this.settledSeen === false) {
      this.matchRef = this.progress.match(await this.d.fetchMatch(id, me));
      this.matchAt = now();
    }
    const m = this.matchRef;
    this.patch({ match: m, refundable: !!m && m.status === "active" && now() / 1000 > m.deadline });
    if (!m) return this.patchStage("notfound");
    if (m.seat === null && m.backerSeat === null) return this.patchStage("spectator");
    if (m.seat === null) {
      // A Backer watches: the result comes from the chain.
      if (m.status === "settled" || m.status === "refunded") return void (await this.settle(m));
      return this.patchStage("backer");
    }
    const seat = m.seat;
    if (m.status === "open") return this.patchStage("waiting", { seat });

    // Active or finished: the table the operator bound this Match to.
    if (!this.assign) {
      const a = await chain.readAssignment(mk);
      if (a) {
        this.assign = a;
        this.patch({ assignment: a });
        this.watch(a);
      }
    }
    const a = this.assign;

    if (m.status === "settled" || m.status === "refunded") {
      if (a && !this.baseRef) {
        this.baseRef = await chain.readTableOnBase(a).catch(() => null);
        const log = this.baseRef ? runLogOf(this.baseRef, m.address, a.epoch) : null;
        const tb = this.baseRef && tableOf(a, this.baseRef) ? this.baseRef : null;
        this.patch({ table: tb ?? this.tableRef, reason: log?.reason ?? tb?.reason ?? null, result: sessionFromTable(this.baseRef, m.address, a.epoch) });
      }
      this.patchStage("settled", { seat, commit: null });
      return void (await this.settle(m));
    }

    if (!a) return this.patchStage(isCancelling(m) ? "cancelling" : "table", { seat });

    // The table: the websocket's copy when it is fresh, else a read.
    let t = this.tableRef && now() - this.tableAt < 1_500 ? this.tableRef : null;
    if (!t) {
      const read = await chain.readTable(p, a).catch(() => null);
      if (read && tableOf(a, read)) {
        t = read;
        this.tableRef = read;
        this.tableAt = now();
        this.patch({ table: read, reconnecting: false });
      } else if (!read) {
        this.patch({ reconnecting: true });
      }
    }
    const slot = this.clockRef ? slotNow(this.clockRef, performance.now()) : null;
    if (t && slot === null && !this.clockRef) {
      const at = performance.now();
      this.clockRef = sampleClock(await chain.currentSlot(p), at);
      this.patch({ clock: this.clockRef });
    }
    const slotNowV = this.clockRef ? slotNow(this.clockRef, performance.now()) : 0;

    // How long the table has been in this state, as this page sees it.
    const key = stateKey(t, a);
    if (this.keyRef.key !== key) this.keyRef = { key, since: now() };
    const stalledMs = now() - this.keyRef.since;

    // Own Board: needed to begin, and to resume after a reload.
    if (t && tableOf(a, t) && t.seatsOpen && !this.boardRef?.began && ["getReady", "running", "frozen", "grace"].includes(phaseAt(t, slotNowV))) {
      this.boardRef = await chain.readOwnBoard(p, a, seat).catch(() => null);
    }

    // Once the table is closed, the base layer's committed copy is what `finalize` reads.
    let baseTable = this.baseRef;
    if (t && t.phase === TABLE_PHASE.closed && !t.dirty && (!baseTable || !tableOf(a, baseTable))) {
      baseTable = await chain.readTableOnBase(a).catch(() => null);
      this.baseRef = baseTable;
    } else if (t && !tableOf(a, t)) {
      baseTable = await chain.readTableOnBase(a).catch(() => null);
      this.baseRef = baseTable;
    }

    const s = nextStep({ seat, status: m.status, assignment: a, table: t, baseTable: baseTable ?? null, slot: slotNowV, nowS: now() / 1000, board: this.boardRef, stalledMs });

    // The stage the Player sees.
    const phase = t ? phaseAt(t, slotNowV) : null;
    const reason = t && t.phase === TABLE_PHASE.closed ? t.reason : null;
    const stage = tableStage({ hasTable: !!t, running: s.kind === "run", phase, closed: !!t && t.phase === TABLE_PHASE.closed, began: !!this.boardRef?.began });
    this.patchStage(stage, reason === null ? { seat } : { seat, reason });
    if (stage === "closing" && !this.closingSince) this.closingSince = now();
    if (t && t.phase === TABLE_PHASE.closed && t.dirty && !this.commitSince) this.commitSince = now();
    if (this.commitSince) {
      const cp = commitPhase(this.commitSince, now());
      this.set((v) => (v.commit?.phase === cp ? v : { ...v, commit: { phase: cp, won: false } }));
    }

    if (s.kind === "wait" || s.kind === "done") return;
    if (s.kind === "run") {
      if (!this.submitter && !this.beginning && this.boardRef?.began && t) await this.startRun(a, t, seat, this.boardRef);
      return;
    }
    const gap = MIN_GAP_MS[s.kind] ?? 2_000;
    if (now() - (this.lastTry[s.kind] ?? 0) < gap) return;
    this.lastTry[s.kind] = now();
    if (!t) return;
    try {
      switch (s.kind) {
        case "beginMatch":
          await chain.beginMatch(p, a);
          break;
        case "seatPlayers":
          await chain.seatPlayers(p, a);
          break;
        case "checkIn":
          await chain.checkIn(p, t);
          break;
        case "requestSeed":
          await chain.requestSeed(p, a);
          break;
        case "start":
          await chain.start(p, a);
          break;
        case "begin": {
          await chain.begin(p, t, seat);
          this.boardRef = await chain.readOwnBoard(p, a, seat).catch(() => null);
          break;
        }
        case "close":
          await chain.close(p, a);
          break;
        case "commitTable":
          await chain.commitTable(p, a);
          break;
        case "finalize": {
          const sig = await chain.finalize(p, a);
          this.addSig("finalize", sig, "base");
          break;
        }
      }
      this.failures = 0;
    } catch (e) {
      // Another page (or the keeper) did this step first: the table has moved on. Anything else counts.
      if (/WrongPhase|AlreadyCheckedIn|AlreadyBegan|SeatsOpen|SeedRequestNotDue|NotDirty|AlreadyFinalized|insufficient|Attempt to debit/i.test(String(e))) return;
      if (++this.failures >= 3) throw e;
    }
  }

  /** One pass of the driver; the screen and the script call it every second. */
  async tick() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      await this.step();
      this.set((v) => (v.error && !v.error.startsWith("Some moves") ? { ...v, error: null } : v));
    } catch (e) {
      this.patch({ error: errText(e) });
    } finally {
      this.working = false;
    }
  }
}
