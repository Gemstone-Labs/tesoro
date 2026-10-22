"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockPuzzleChain, type ChainSigner } from "./chain";
import { getBurst } from "@/lib/chain/client";
import { sessionFromTable, type BurstSession } from "@/lib/chain/burst-read";
import { matchAddressOf } from "@/lib/chain/match-id";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { commitPhase, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { plainError } from "@/lib/errors";
import {
  TABLE_PHASE,
  canPlayPublic,
  phaseAt,
  runLogOf,
  tableOf,
  type Assignment,
  type OwnBoard,
  type PlayerSigner,
  type Table,
} from "./live-chain";
import { mergeClock, runRemainingMs, sampleClock, slotNow, type SlotClock } from "./live-clock";
import { nextStep, type Step } from "./live-driver";
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

const errText = plainError;
const now = () => Date.now();

/** The facts about a table that decide the driver's next step; unchanged for a while means the keeper is not moving it. */
const stateKey = (t: Table | null, a: Assignment | null) =>
  t ? [a?.epoch, t.epoch, t.phase, t.seatsOpen, t.checkedIn.join(), t.seedReady, t.reqPending, t.reqCount, t.startSlot, t.dirty].join("|") : "none";

/** Steps nobody should repeat faster than this, ms. */
const MIN_GAP_MS: Partial<Record<Step["kind"], number>> = { beginMatch: 2_500, seatPlayers: 2_500, requestSeed: 5_000, start: 2_500, close: 2_500, commitTable: 5_000, finalize: 8_000, checkIn: 1_500, begin: 600 };
const SLOT_EVERY_MS = 2_000;

/**
 * Drives one Block Burst Match for one Player. The keeper does the steps anyone may do; this page does them when the table
 * has not moved for a few seconds, so a Match never waits on the keeper. Every step re-reads chain state, and a lost race is
 * harmless.
 */
export function useBurstMatch(id: string | null, signer: ChainSigner | null, accountKey: string | null, onSettled?: () => void) {
  const [view, setView] = useState<BurstView>({
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
  const patch = useCallback((p: Partial<BurstView>) => setView((v) => ({ ...v, ...p })), []);

  const working = useRef(false);
  const mk = useMemo(() => (id === null ? null : matchAddressOf(id)), [id]);
  const p = useMemo(() => (signer ? (signer as unknown as PlayerSigner) : null), [signer]);

  const assignRef = useRef<Assignment | null>(null);
  const tableRef = useRef<Table | null>(null);
  const tableAt = useRef(0);
  const baseRef = useRef<Table | null>(null);
  const clockRef = useRef<SlotClock | null>(null);
  const boardRef = useRef<OwnBoard | null>(null);
  const matchRef = useRef<ChainMatch | null>(null);
  const matchAt = useRef(0);
  const keyRef = useRef({ key: "", since: 0 });
  const lastTry = useRef<Partial<Record<Step["kind"], number>>>({});
  const submitter = useRef<BurstSubmitter | null>(null);
  const lock = useRef<SubmitterLock | null>(null);
  const beginning = useRef(false);
  const settledSeen = useRef(false);
  const closingSince = useRef(0);
  const commitSince = useRef(0);
  const failures = useRef(0);

  const addSig = useCallback((label: string, sig: string | undefined, layer: "base" | "tee") => {
    if (sig) setView((v) => (v.sigs.some((x) => x.sig === sig) ? v : { ...v, sigs: [...v.sigs, { label, sig, layer }] }));
  }, []);

  useEffect(() => {
    const chain = getBurst();
    // The moves are not receipts (there are dozens); `close` shares its name with Trading Duel's, so it is named for its table.
    chain.onTx = (label, layer, sig) => (label === "play" || label === "play_hidden" ? undefined : addSig(label === "close" ? "close_table" : label, sig, layer));
    return () => {
      chain.onTx = undefined;
    };
  }, [addSig]);

  // -- the clock: the rollup's slot, read every 2 s and run forward in between ----------------------

  useEffect(() => {
    if (!p || id === null) return;
    let stop = false;
    const read = async () => {
      if (stop || !assignRef.current) return;
      try {
        const at = performance.now();
        const slot = await getBurst().currentSlot(p);
        if (stop) return;
        clockRef.current = mergeClock(clockRef.current, sampleClock(slot, at));
        setView((v) => (v.clock === clockRef.current ? v : { ...v, clock: clockRef.current, reconnecting: false }));
      } catch {
        setView((v) => (v.reconnecting ? v : { ...v, reconnecting: true }));
      }
    };
    const t = setInterval(() => void read(), SLOT_EVERY_MS);
    void read();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [p, id]);

  // -- the table: websocket with a polling fallback --------------------------------------------------

  const [watchKey, setWatchKey] = useState("");
  useEffect(() => {
    const a = assignRef.current;
    if (!p || !a || !watchKey) return;
    let stopFeed: (() => void) | null = null;
    let cancelled = false;
    void getBurst()
      .watchTable(
        p,
        a,
        (t) => {
          if (!tableOf(a, t)) return;
          tableRef.current = t;
          tableAt.current = now();
          setView((v) => ({ ...v, table: t, reconnecting: false }));
        },
        () => setView((v) => (v.reconnecting ? v : { ...v, reconnecting: true })),
      )
      .then((stop) => {
        if (cancelled) stop();
        else stopFeed = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stopFeed?.();
    };
  }, [p, watchKey]);

  // -- the driver ------------------------------------------------------------------------------------

  const startRun = useCallback(
    async (a: Assignment, t: Table, seat: 0 | 1, board: OwnBoard) => {
      if (!p || id === null || submitter.current || beginning.current) return;
      beginning.current = true;
      try {
        const l = await acquireSubmitterLock(id, accountKey ?? p.publicKey.toBase58());
        lock.current = l;
        if (!l.held) {
          patch({ elsewhere: true });
          return;
        }
        const chain = getBurst();
        const startCount = board.moves;
        // The reconnect: the Seed and the move log rebuild the run exactly as the chain holds it.
        const resume = resumeState(board);
        const sub = new BurstSubmitter(
          {
            send: (moves, expected, hidden) => chain.play(p, tableRef.current ?? t, seat, expected, moves, hidden),
            movesOnChain: async () => (await chain.readOwnBoard(p, a, seat).catch(() => null))?.moves ?? null,
            frozen: () => !(tableRef.current && clockRef.current && canPlayPublic(tableRef.current, slotNow(clockRef.current, performance.now()))),
          },
          { startCount },
        );
        submitter.current = sub;
        const run: MatchRun = {
          seed: board.seed,
          entry: matchRef.current?.entry ?? 0,
          resume: startCount > 0 ? resume : undefined,
          remainingMs: () => (tableRef.current && clockRef.current ? runRemainingMs(tableRef.current, clockRef.current, performance.now()) : 0),
          onMove: (m) => sub.push(m),
          onEnd: () => {
            patch({ ownOver: true });
            void sub.finish().then(() => {
              if (sub.error) patch({ error: `Some moves were not accepted: ${errText(sub.error)}` });
            });
          },
        };
        patch({ run, elsewhere: false });
      } finally {
        beginning.current = false;
      }
    },
    [p, id, accountKey, patch],
  );

  const settle = useCallback(
    async (m: ChainMatch) => {
      if (!settledSeen.current) {
        settledSeen.current = true;
        submitter.current = null;
        lock.current?.release();
        setCommitPending(m.id, false);
        onSettled?.();
      }
    },
    [onSettled],
  );

  const step = useCallback(async () => {
    if (!p || !signer || id === null || mk === null) return;
    const chain = getBurst();
    const me = BlockPuzzleChain.coreAccount(signer.publicKey);
    if (!matchRef.current || now() - matchAt.current > 2_500 || settledSeen.current === false) {
      matchRef.current = await fetchMatch(id, me);
      matchAt.current = now();
    }
    const m = matchRef.current;
    patch({ match: m, refundable: !!m && m.status === "active" && now() / 1000 > m.deadline });
    if (!m) return patch({ stage: "notfound" });
    if (m.seat === null && m.backerSeat === null) return patch({ stage: "spectator" });
    if (m.seat === null) {
      // A Backer watches: the result comes from the chain.
      if (m.status === "settled" || m.status === "refunded") return void (await settle(m));
      return patch({ stage: "backer" });
    }
    const seat = m.seat;
    if (m.status === "open") return patch({ stage: "waiting", seat });

    // Active or finished: the table the operator bound this Match to.
    if (!assignRef.current) {
      const a = await chain.readAssignment(mk);
      if (a) {
        assignRef.current = a;
        patch({ assignment: a });
        setWatchKey(a.address.toBase58());
      }
    }
    const a = assignRef.current;

    if (m.status === "settled" || m.status === "refunded") {
      if (a && !baseRef.current) {
        baseRef.current = await chain.readTableOnBase(a).catch(() => null);
        const log = baseRef.current ? runLogOf(baseRef.current, m.address, a.epoch) : null;
        const tb = baseRef.current && tableOf(a, baseRef.current) ? baseRef.current : null;
        patch({ table: tb ?? tableRef.current, reason: log?.reason ?? tb?.reason ?? null, result: sessionFromTable(baseRef.current, m.address, a.epoch) });
      }
      patch({ stage: "settled", seat, commit: null });
      return void (await settle(m));
    }

    if (!a) return patch({ stage: "table", seat });

    // The table: the websocket's copy when it is fresh, else a read.
    let t = tableRef.current && now() - tableAt.current < 1_500 ? tableRef.current : null;
    if (!t) {
      const read = await chain.readTable(p, a).catch(() => null);
      if (read && tableOf(a, read)) {
        t = read;
        tableRef.current = read;
        tableAt.current = now();
        patch({ table: read, reconnecting: false });
      } else if (!read) {
        patch({ reconnecting: true });
      }
    }
    const slot = clockRef.current ? slotNow(clockRef.current, performance.now()) : null;
    if (t && slot === null && !clockRef.current) {
      const at = performance.now();
      clockRef.current = sampleClock(await chain.currentSlot(p), at);
      patch({ clock: clockRef.current });
    }
    const slotNowV = clockRef.current ? slotNow(clockRef.current, performance.now()) : 0;

    // How long the table has been in this state, as this page sees it.
    const key = stateKey(t, a);
    if (keyRef.current.key !== key) keyRef.current = { key, since: now() };
    const stalledMs = now() - keyRef.current.since;

    // Own Board: needed to begin, and to resume after a reload.
    if (t && tableOf(a, t) && t.seatsOpen && !boardRef.current?.began && ["getReady", "running", "frozen", "grace"].includes(phaseAt(t, slotNowV))) {
      boardRef.current = await chain.readOwnBoard(p, a, seat).catch(() => null);
    }

    // Once the table is closed, the base layer's committed copy is what `finalize` reads.
    let baseTable = baseRef.current;
    if (t && t.phase === TABLE_PHASE.closed && !t.dirty && (!baseTable || !tableOf(a, baseTable))) {
      baseTable = await chain.readTableOnBase(a).catch(() => null);
      baseRef.current = baseTable;
    } else if (t && !tableOf(a, t)) {
      baseTable = await chain.readTableOnBase(a).catch(() => null);
      baseRef.current = baseTable;
    }

    const s = nextStep({ seat, status: m.status, assignment: a, table: t, baseTable: baseTable ?? null, slot: slotNowV, nowS: now() / 1000, board: boardRef.current, stalledMs });

    // The stage the Player sees.
    const phase = t ? phaseAt(t, slotNowV) : null;
    const reason = t && t.phase === TABLE_PHASE.closed ? t.reason : null;
    const stage: Stage = !t ? "table" : s.kind === "run" || (phase && ["running", "frozen", "grace"].includes(phase) && boardRef.current?.began) ? "playing" : phase === "getReady" || phase === "running" || phase === "frozen" || phase === "grace" ? "getReady" : phase === "ended" || t.phase === TABLE_PHASE.closed ? "closing" : "setup";
    patch(reason === null ? { stage, seat } : { stage, seat, reason });
    if (stage === "closing" && !closingSince.current) closingSince.current = now();
    if (t && t.phase === TABLE_PHASE.closed && t.dirty && !commitSince.current) commitSince.current = now();
    if (commitSince.current) {
      const cp = commitPhase(commitSince.current, now());
      setView((v) => (v.commit?.phase === cp ? v : { ...v, commit: { phase: cp, won: false } }));
    }

    if (s.kind === "wait" || s.kind === "done") return;
    if (s.kind === "run") {
      if (!submitter.current && !beginning.current && boardRef.current?.began && t) await startRun(a, t, seat, boardRef.current);
      return;
    }
    const gap = MIN_GAP_MS[s.kind] ?? 2_000;
    if (now() - (lastTry.current[s.kind] ?? 0) < gap) return;
    lastTry.current[s.kind] = now();
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
          boardRef.current = await chain.readOwnBoard(p, a, seat).catch(() => null);
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
          addSig("finalize", sig, "base");
          break;
        }
      }
      failures.current = 0;
    } catch (e) {
      // Another page (or the keeper) did this step first: the table has moved on. Anything else counts.
      if (/WrongPhase|AlreadyCheckedIn|AlreadyBegan|SeatsOpen|SeedRequestNotDue|NotDirty|AlreadyFinalized|insufficient|Attempt to debit/i.test(String(e))) return;
      if (++failures.current >= 3) throw e;
    }
  }, [p, signer, id, mk, patch, settle, startRun, addSig]);

  const tick = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      await step();
      setView((v) => (v.error && !v.error.startsWith("Some moves") ? { ...v, error: null } : v));
    } catch (e) {
      patch({ error: errText(e) });
    } finally {
      working.current = false;
    }
  }, [step, patch]);

  useEffect(() => {
    if (!p || id === null) return;
    const first = setTimeout(() => void tick(), 0);
    const t = setInterval(() => void tick(), 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [p, id, tick]);

  useEffect(
    () => () => {
      lock.current?.release();
    },
    [],
  );

  return { view, tick };
}
