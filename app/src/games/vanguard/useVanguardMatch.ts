"use client";

import { atAssignedEpoch } from "@/lib/chain/table-epoch";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getVanguard } from "@/lib/chain/client";
import { matchAddressOf } from "@/lib/chain/match-id";
import { NO_TABLE_NOTE } from "@/lib/chain/match-status";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { commitPhase, isCommitPending, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { plainError } from "@/lib/errors";
import { absenceLine } from "@/lib/absence-copy";
import { isStale, refusalLine } from "./refusal";
import { TABLE_PHASE, canFinalizeTable, tableOf, type Assignment, type DeclareSeal, type PlayerSigner, type TableState } from "./chain";
import { SealLedger, SealLocked, sealDeclare, sealPad, type SealedEntry } from "./seal";
import { turnKey } from "./clock";
import { actionsDue, contributeBundled, readDue, tickDelayMs } from "./driver";
import { STATUS, battleKey, type ArmyAccount, type Battle } from "./decode";

/** Where a Vanguard Match is in its life, read from chain. */
export type Stage = "loading" | "notfound" | "spectator" | "waiting" | "setup" | "live" | "closing" | "settled";

export interface VanguardView {
  stage: Stage;
  match: ChainMatch | null;
  seat: 0 | 1 | null;
  /** The public Battle from the private rollup (the committed one once the Match is settled). */
  battle: Battle | null;
  /** Your own Army, read with your TEE token. */
  army: ArmyAccount | null;
  /** When this client first saw the current turn (ms): the turn countdown runs from here. */
  turnSeenAt: number;
  note: string;
  error: string | null;
  sigs: { label: string; sig: string; layer: "base" | "tee" }[];
  busy: string | null;
  /** The tesoro_core refund deadline passed on an unfinished Match. */
  refundable: boolean;
  commit: CommitState | null;
  /** Reads of the Battle keep failing: the board shown may be behind. */
  reconnecting: boolean;
}

/** What a Player's action carries besides its piece: Become a Spy rides on the action (free, secret). */
export interface ActionOptions {
  spy?: boolean;
}

/** The sealed-bytes ledger survives a reload of the page (sessionStorage), so a retry after a reload still resends the same bytes. */
function sealStore(matchId: string, seat: number) {
  const key = `vanguard-seal:${matchId}:${seat}`;
  return {
    load: (): SealedEntry[] => {
      try {
        const raw = window.sessionStorage.getItem(key);
        return raw ? (JSON.parse(raw) as SealedEntry[]) : [];
      } catch {
        return [];
      }
    },
    save: (entries: SealedEntry[]) => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(entries));
      } catch {
        // storage can be blocked; the in-memory ledger still holds for this page
      }
    },
  };
}

const sameArmy = (a: ArmyAccount, b: ArmyAccount): boolean => a.moves === b.moves && a.fuel === b.fuel && a.side === b.side && a.ranks.every((r, i) => r === b.ranks[i]);

/** How long the Player who does not settle at once waits before settling a still-open Match. */
const FINALIZE_GRACE_MS = 20_000;
/** The opener steps in for the joiner's set-up steps after this long. */
const OPENER_LATE_MS = 12_000;
const now = () => Date.now();

/** The table the Match is assigned to; a Player's action before it exists is refused. */
const must = (a: Assignment | null): Assignment => {
  if (!a) throw new Error("Not ready");
  return a;
};

/**
 * Drives one Vanguard Match for one Player: reads the table, the Battle and your own Army from the private rollup and
 * does every step that is not a move (begin the Match on its table, seat the Players, check in, entropy and the deal,
 * commit the result and settle from it, and a timeout claim once a deadline has passed). The operator binds the Match to a
 * table; both Players' clients run the same driver; a step that either may do is tried by one client first and by the
 * other after a grace period, and a lost race is harmless because each step re-reads chain state.
 */
export function useVanguardMatch(id: string | null, signer: ChainSigner | null, onSettled?: () => void) {
  const [view, setView] = useState<VanguardView>({
    stage: "loading",
    match: null,
    seat: null,
    battle: null,
    army: null,
    turnSeenAt: 0,
    note: "",
    error: null,
    sigs: [],
    busy: null,
    refundable: false,
    commit: null,
    reconnecting: false,
  });
  const patch = useCallback((p: Partial<VanguardView>) => setView((v) => ({ ...v, ...p })), []);

  const working = useRef(false);
  const stage = useRef<Stage>("loading");
  const seatRef = useRef<0 | 1 | null>(null);
  const shownKey = useRef("");
  const turnId = useRef("");
  const activeSince = useRef(0);
  const closingSince = useRef(0);
  const lastClose = useRef(0);
  const commitSince = useRef(0);
  const closeFailures = useRef(0);
  const contributed = useRef(false);
  const contributedAt = useRef(0);
  const lastVrf = useRef(0);
  const assignRef = useRef<Assignment | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const lastClaim = useRef(0);
  const lastResolve = useRef(0);
  const battleRef = useRef<Battle | null>(null);
  const armyRef = useRef<ArmyAccount | null>(null);
  const ledgerRef = useRef<{ key: string; ledger: SealLedger } | null>(null);
  const lastUpdate = useRef(0);
  const lastRead = useRef(0);
  const armyKey = useRef("");
  const tickRef = useRef<() => void>(() => undefined);
  const settledSeen = useRef(false);
  const finalRead = useRef(false);
  const failures = useRef(0);
  const turnSeenRef = useRef(0);

  useEffect(() => {
    turnSeenRef.current = view.turnSeenAt;
  }, [view.turnSeenAt]);
  const mk = useMemo(() => (id === null ? null : matchAddressOf(id)), [id]);
  const p = useMemo(() => (signer ? (signer as unknown as PlayerSigner) : null), [signer]);

  const setStage = useCallback((s: Stage, note = "") => {
    stage.current = s;
    setView((v) => (v.stage === s && v.note === note ? v : { ...v, stage: s, note }));
  }, []);

  const addSig = useCallback((label: string, sig: string | undefined, layer: "base" | "tee") => {
    if (sig) setView((v) => (v.sigs.some((x) => x.sig === sig) ? v : { ...v, sigs: [...v.sigs, { label, sig, layer }] }));
  }, []);

  const applyBattle = useCallback((b: Battle) => {
    // The table's Battle is reused by later Matches: only this Match's is shown.
    if (mk !== null && !b.tesoroMatch.equals(mk)) return;
    battleRef.current = b;
    const k = battleKey(b);
    if (k === shownKey.current) return;
    shownKey.current = k;
    const tk = turnKey(b);
    const fresh = tk !== turnId.current;
    turnId.current = tk;
    setView((v) => ({ ...v, battle: b, turnSeenAt: fresh ? now() : v.turnSeenAt }));
  }, [mk]);

  useEffect(() => {
    const vg = getVanguard();
    vg.onTx = (label, layer, sig) => addSig(label, sig, layer);
    return () => {
      vg.onTx = undefined;
    };
  }, [addSig]);

  // -- the driver (sequential; one step per tick) --------------------------------------------

  /**
   * Settles from the committed table once base has the result. One Player settles at once (the winner; seat 0 for a refund), the
   * other waits and settles only if the Match is still open then, so the loser of a race does not burn a fee.
   */
  const settle = useCallback(
    async (a: Assignment, seat: 0 | 1, b: Battle | null) => {
      if (!p || !signer || id === null) return;
      const vg = getVanguard();
      if (!closingSince.current) closingSince.current = now();
      const refund = !b || b.status === STATUS.cancelled || b.winner !== 0 && b.winner !== 1;
      const mine = refund ? seat === 0 : b!.winner === seat;
      if (!mine && now() - closingSince.current < FINALIZE_GRACE_MS) return;
      const base = await vg.readTableOnBase(a);
      if (!base || !canFinalizeTable(base, a, Date.now() / 1000)) return;
      setView((v) => (v.commit ? { ...v, commit: null } : v));
      try {
        await vg.finalize(p, a);
      } catch (e) {
        // The other Player may have settled it in the same moment.
        const again = await fetchMatch(id, BlockPuzzleChain.coreAccount(signer.publicKey));
        if (again && (again.status === "settled" || again.status === "refunded")) return;
        if (++failures.current >= 3) throw e;
      }
    },
    [p, signer, id],
  );

  const step = useCallback(async () => {
    if (!p || !signer || id === null || mk === null) return;
    const vg = getVanguard();
    const me = BlockPuzzleChain.coreAccount(signer.publicKey);
    const m = await fetchMatch(id, me);
    setView((v) => ({ ...v, match: m, refundable: !!m && m.status === "active" && Date.now() / 1000 > m.deadline }));
    if (!m) return setStage("notfound");
    if (m.seat === null) return setStage("spectator");
    const seat = m.seat;
    seatRef.current = seat;
    setView((v) => (v.seat === seat ? v : { ...v, seat }));
    if (m.status === "open") return setStage("waiting");
    if (m.status === "settled" || m.status === "refunded") {
      setStage("settled");
      if (!finalRead.current) {
        finalRead.current = true;
        // The board of a Match whose table was reused is gone from base: the screen then shows the core result alone.
        const a = await vg.readAssignment(mk!);
        const b = a ? await vg.readBattleOnBase(a) : null;
        if (b && b.tesoroMatch.equals(mk!)) setView((v) => ({ ...v, battle: b }));
      }
      if (!settledSeen.current) {
        settledSeen.current = true;
        setCommitPending(id, false);
        onSettled?.();
      }
      return;
    }

    // Active: the operator binds the Match to a table; then the table begins it, seats the Players and both check in.
    if (!activeSince.current) activeSince.current = now();
    // The joiner does the steps either Player may do; the opener steps in if that stalls.
    const late = now() - activeSince.current >= (seat === 1 ? 0 : OPENER_LATE_MS);
    const a = await vg.readAssignment(mk!);
    if (!a) return setStage("setup", NO_TABLE_NOTE);
    if (assignRef.current?.address.toBase58() !== a.address.toBase58()) {
      assignRef.current = a;
      setAssignment(a);
    }
    const t = await vg.readTable(p, a);
    if (!t) return setStage("setup", "Setting up the Match");
    const nowS = Math.floor(Date.now() / 1000);
    if (t.phase === TABLE_PHASE.idle && atAssignedEpoch(a, t)) {
      setStage("setup", "Starting the Match");
      if (late && nowS <= a.startDeadline) await vg.beginMatch(p, a).catch(() => undefined);
      return;
    }
    if (!tableOf(a, t)) {
      // The table has been wiped for its next Match: the result lives in the committed ring.
      setStage("closing", "Paying out the Pot");
      return settle(a, seat, null);
    }
    const b = await vg.readBattle(p, a);
    if (!b || !b.tesoroMatch.equals(mk!)) return setStage("setup", "Setting up the Match");
    applyBattle(b);
    if (t.phase === TABLE_PHASE.waiting) {
      if (nowS > t.startDeadline) {
        // Never both checked in: the Player who came wins, nobody coming is a no-show.
        setStage("setup", absenceLine(t.checkedIn, seat));
        if (seat === 1 || now() - activeSince.current > OPENER_LATE_MS) await vg.claimTimeout(p, a).catch(() => undefined);
        return;
      }
      if (!t.seatsOpen) {
        setStage("setup", "Creating your session");
        if (late) await vg.seatPlayers(p, a).catch(() => undefined);
        return;
      }
      if (!t.checkedIn[seat]) {
        setStage("setup", "Joining the Match");
        await vg.checkIn(p, a);
        return;
      }
      setStage("setup", "Waiting for your opponent");
      return;
    }

    if (t.phase === TABLE_PHASE.live) {
      if (b.status === STATUS.setup) {
        setStage("setup", "Drawing the armies in secret");
        await setUp(seat, a, t, b);
        return;
      }
      setStage("live");
      return;
    }

    // Over: commit the public result, then settle from the committed ring.
    setStage("closing", "Saving the result");
    if (!closingSince.current) closingSince.current = now();
    const refund = b.status === STATUS.cancelled || (b.winner !== 0 && b.winner !== 1);
    const mine = refund ? seat === 0 : b.winner === seat;
    if (t.dirty) {
      if (!mine && now() - closingSince.current < 15_000) return;
      if (now() - lastClose.current < 10_000) return;
      lastClose.current = now();
      try {
        await vg.commitTable(p, a);
        closeFailures.current = 0;
      } catch (e) {
        // The other Player committed first, or the commit is already in flight: only other errors count.
        if (!isCommitPending(e) && !/NotDirty/.test(String(e)) && ++closeFailures.current >= 3) throw e;
        if (!isCommitPending(e) && !/NotDirty/.test(String(e))) return;
      }
      if (!commitSince.current) commitSince.current = now();
      setCommitPending(id, true);
      setView((v) => ({ ...v, commit: { phase: "sending", won: mine } }));
      return;
    }
    if (commitSince.current) {
      const phase = commitPhase(commitSince.current, now());
      setView((v) => (v.commit?.phase === phase && v.commit.won === mine ? v : { ...v, commit: { phase, won: mine }, error: null }));
    }
    await settle(a, seat, b);

    async function setUp(s: 0 | 1, ref: Assignment, tb: TableState, current: Battle) {
      if (!p || id === null) return;
      // The secret is sent once per Match: a retry would send a second one, so the seat is asked first.
      if (!contributed.current) {
        if (!(await vg.hasContributed(p, ref, s))) await contributeBundled(vg, p, ref, s, current.oracleQueue);
        contributed.current = true;
        contributedAt.current = now();
        lastVrf.current = 0;
        return;
      }
      if (tb.vrfReady) {
        await vg.deal(p, ref).catch(() => undefined);
        return;
      }
      // The request is made once per Match (the program refuses a second one): the second contributor asked with its secret;
      // either Player asks if that did not happen.
      if (!tb.reqMade && !tb.reqPending && (s === 1 || now() - contributedAt.current > 6_000) && now() - lastVrf.current > 5_000) {
        lastVrf.current = now();
        try {
          await vg.requestVrf(p, ref, current.oracleQueue);
        } catch {
          // Refused until the other Player's secret is in, or the other Player asked first.
        }
      }
    }
  }, [p, signer, id, mk, setStage, applyBattle, onSettled, settle]);

  const tick = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      await step();
      setView((v) => (v.error ? { ...v, error: null } : v));
    } catch (e) {
      patch({ error: plainError(e) });
    } finally {
      working.current = false;
    }
  }, [step, patch]);

  useEffect(() => {
    tickRef.current = () => void tick();
  }, [tick]);

  // The driver reads the Match, the base-layer Battle and the rollup Battle each pass: while the Match is live the
  // Battle subscription carries the board, so passes come slowly.
  useEffect(() => {
    if (!p || id === null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await tick();
      if (!stop) timer = setTimeout(() => void loop(), tickDelayMs(stage.current));
    };
    timer = setTimeout(() => void loop(), 0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [p, id, tick]);

  // -- the reader (fast, independent of the driver) -------------------------------------------

  useEffect(() => {
    if (!p || id === null || !assignment) return;
    const ref = assignment;
    let stop = false;
    let busy = false;
    let unwatch: (() => void) | null = null;
    const live = () => {
      const seat = seatRef.current;
      return seat !== null && ["live", "closing", "setup"].includes(stage.current) ? seat : null;
    };
    const readArmy = async (b: Battle) => {
      const seat = live();
      if (seat === null || b.status < STATUS.setup) return;
      const key = [b.status, b.turnNo, b.moves, b.actionSeq].join(":");
      if (key === armyKey.current) return;
      armyKey.current = key;
      const army = await getVanguard().readOwnArmy(p, ref, seat).catch(() => null);
      if (army && army.dealt && army.ranks.some((r) => r !== 0) && !stop) {
        armyRef.current = army;
        setView((v) => (v.army && sameArmy(v.army, army) ? v : { ...v, army }));
      }
    };
    // What to send from the Battle held, no reads: a declared move or timeout waits for a later slot (either Player
    // or the keeper applies it), and past a deadline the program passes the turn, ends the Match on the cap or
    // cancels it; anyone may ask.
    const send = async () => {
      const b = battleRef.current;
      if (!b || stop || live() === null) return;
      const due = actionsDue(b, turnSeenRef.current || now(), now(), lastResolve.current, lastClaim.current);
      const vg = getVanguard();
      if (due.resolve) {
        lastResolve.current = now();
        await vg.resolve(p, ref).catch(() => undefined);
      }
      if (due.claim) {
        lastClaim.current = now();
        await vg.claimTimeout(p, ref).catch(() => undefined);
      }
    };
    void getVanguard()
      .watchBattle(p, ref, (b) => {
        if (stop || (mk !== null && !b.tesoroMatch.equals(mk))) return;
        lastUpdate.current = now();
        applyBattle(b);
        void readArmy(b);
        void send();
        if (b.status !== STATUS.live && stage.current === "live") tickRef.current();
      })
      .then((u) => {
        if (stop) u();
        else unwatch = u;
      })
      .catch(() => undefined);
    // The subscription may miss an update: read the Battle only when it has been quiet for a while.
    const poll = async () => {
      if (busy || stop || live() === null) return;
      busy = true;
      try {
        if (readDue(now(), lastUpdate.current, lastRead.current)) {
          const b = await getVanguard().readBattle(p, ref);
          lastRead.current = now();
          if (!b || stop || (mk !== null && !b.tesoroMatch.equals(mk))) return;
          setView((v) => (v.reconnecting ? { ...v, reconnecting: false } : v));
          applyBattle(b);
          await readArmy(b);
        }
        await send();
      } catch {
        // The driver reports persistent failures; a missed poll is retried, and the board says it is behind.
        if (!stop) setView((v) => (v.reconnecting ? v : { ...v, reconnecting: true }));
      } finally {
        busy = false;
      }
    };
    const t = setInterval(() => void poll(), 1000);
    return () => {
      stop = true;
      unwatch?.();
      clearInterval(t);
    };
  }, [p, id, mk, assignment, applyBattle]);

  // -- Player decisions -----------------------------------------------------------------------

  /**
   * The sealing for the declare about to be sent: the Battle's `action_seq` now and the sealed bytes of this turn. The
   * ledger hands back the same bytes for a seq it already sealed, and refuses a different choice for it.
   */
  const sealFor = useCallback(
    async (o: ActionOptions, withSlot: boolean, digIn: number | null): Promise<DeclareSeal & { sealedSlot: number }> => {
      const b = battleRef.current;
      const army = armyRef.current;
      const seat = seatRef.current;
      if (!b || !army || seat === null || id === null || mk === null) throw new Error("Not ready");
      const hex = Array.from(army.sealKey, (x) => x.toString(16).padStart(2, "0")).join("");
      if (ledgerRef.current?.key !== hex) {
        // The pad is bound to the tesoro_core Match (the Battle address is the same for every Match on a table).
        const binding = mk.toBytes();
        ledgerRef.current = { key: hex, ledger: new SealLedger((seq, field) => sealPad(army.sealKey, binding, seat, seq, field), sealStore(id, seat)) };
      }
      return sealDeclare(ledgerRef.current.ledger, b.actionSeq, army, { spy: !!o.spy, withSlot, digIn });
    },
    [id, mk],
  );

  /** A declare landed: the program applies it in a later slot. Try right away; the poll keeps trying if this misses. */
  const applyDeclared = useCallback(async () => {
    if (!p || id === null) return;
    const vg = getVanguard();
    for (let i = 0; i < 4; i++) {
      if (await vg.resolve(p, must(assignRef.current)).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }, [p, id]);

  /** Send one declare. A stale `expected_seq` re-reads the Battle (the board snaps to what is confirmed); the message says what happened. */
  const declare = useCallback(
    async (send: () => Promise<unknown>) => {
      if (!p || id === null) throw new Error("Not ready");
      try {
        await send();
        await applyDeclared();
      } catch (e) {
        if (e instanceof SealLocked) throw new Error(e.message);
        if (isStale(e)) {
          const fresh = await getVanguard().readBattle(p, must(assignRef.current)).catch(() => null);
          if (fresh) applyBattle(fresh);
        }
        throw new Error(refusalLine(e));
      }
    },
    [p, id, applyDeclared, applyBattle],
  );

  /** Send a move. Resolves when the rollup confirmed it, rejects (with a plain message) when it did not. */
  const move = useCallback(
    async (piece: number, to: number, o: ActionOptions = {}) =>
      declare(async () => {
        const seal = await sealFor(o, false, null);
        return getVanguard().movePiece(p!, must(assignRef.current), piece, to, seal);
      }),
    [declare, sealFor, p],
  );

  /** Blast or Rescue with `piece`, or Dig in (a pass whose sealed slot names the Major). */
  const power = useCallback(
    async (kind: "blast" | "rescue" | "dig_in", piece: number, o: ActionOptions = {}) =>
      declare(async () => {
        const vg = getVanguard();
        if (kind === "dig_in") return vg.pass(p!, must(assignRef.current), await sealFor(o, true, piece));
        const seal = await sealFor(o, false, null);
        return kind === "blast" ? vg.blast(p!, must(assignRef.current), piece, seal) : vg.rescue(p!, must(assignRef.current), piece, seal);
      }),
    [declare, sealFor, p],
  );


  const twoStep = useCallback(async () => {
    if (!p || id === null) throw new Error("Not ready");
    try {
      await getVanguard().startTwoStep(p, must(assignRef.current));
    } catch (e) {
      throw new Error(plainError(e));
    }
  }, [p, id]);

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      patch({ busy: label, error: null });
      try {
        const sig = await fn();
        if (sig) addSig(label, sig, "base");
      } catch (e) {
        patch({ error: plainError(e) });
      } finally {
        patch({ busy: null });
      }
    },
    [patch, addSig],
  );

  return { view, move, power, twoStep, tick, run };
}
