"use client";

import { useAuth } from "@/lib/auth/context";
import { finalizeFree } from "@/lib/chain/game-finalize";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getHoldem } from "@/lib/chain/client";
import { matchAddressOf } from "@/lib/chain/match-id";
import { setupNote } from "@/lib/chain/match-status";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import {
  NO_WINNER,
  PHASE,
  STATUS,
  TABLE_PHASE,
  canFinalizeTable,
  tableOf,
  type Action,
  type Assignment,
  type PlayerSigner,
  type Table,
} from "./chain";
import { commitPhase, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { plainError } from "@/lib/errors";
import { absenceLine } from "@/lib/absence-copy";
import { atAssignedEpoch } from "@/lib/chain/table-epoch";

/** Where a Hold'em Match is in its life, read from chain. */
export type Stage =
  | "loading"
  | "notfound"
  | "spectator"
  | "waiting"
  /** Active in tesoro_core; the table is being created, moved to the rollup and started. */
  | "setup"
  | "live"
  /** Over or cancelled; the table is being committed back and settled. */
  | "closing"
  | "settled";

export interface HoldemView {
  stage: Stage;
  match: ChainMatch | null;
  seat: 0 | 1 | null;
  /** The public table from the private rollup (the committed one once the Match is settled). */
  table: Table | null;
  /** Your own hole cards for the hand in `handNo`, read with your TEE token. */
  hole: { handNo: number; cards: [number, number] } | null;
  note: string;
  error: string | null;
  sigs: { label: string; sig: string; layer: "base" | "tee" }[];
  busy: string | null;
  /** The tesoro_core refund deadline passed on an unfinished Match. */
  refundable: boolean;
  /** The result is in and waiting to be committed to the chain (the Match is over, the rollup has not handed it back). */
  commit: CommitState | null;
}

const errText = plainError;
const now = () => Date.now();

/** A key that changes whenever anything a Player can see changes. */
function tableKey(t: Table): string {
  return [t.status, t.tablePhase, t.seatsOpen, t.checkedIn, t.dirty, t.reqPending, t.vrfReady, t.handNo, t.phase, t.toAct, t.deadline, t.stacks, t.bets, t.committed, t.board, t.lastHand.handNo, t.winner, t.missed].join("|");
}

/** How long the Player who does not settle at once waits before settling a still-open Match. */
const FINALIZE_GRACE_MS = 20_000;
/** How long the Player who does not act at once waits before doing a step either Player may do. */
const GRACE_MS = 15_000;

/**
 * Drives one Hold'em Match for one Player: reads the table from the private rollup, and does
 * every step that is not a betting decision (create and delegate the table, start it, per-hand
 * entropy + VRF + deal, close and settle). Both Players' clients run the same driver; steps that
 * either Player may do are tried by one client first and by the other after a grace period, and
 * a lost race is harmless because each step re-reads chain state.
 */
export function useHoldemMatch(id: string | null, signer: ChainSigner | null, onSettled?: () => void) {
  const { getAccessToken } = useAuth();
  // A ref keeps the token getter out of the effect dependencies: the Match loop must not restart when auth re-renders.
  const tokenRef = useRef(getAccessToken);
  useEffect(() => {
    tokenRef.current = getAccessToken;
  }, [getAccessToken]);
  const [view, setView] = useState<HoldemView>({
    stage: "loading",
    match: null,
    seat: null,
    table: null,
    hole: null,
    note: "",
    error: null,
    sigs: [],
    busy: null,
    refundable: false,
    commit: null,
  });
  const patch = useCallback((p: Partial<HoldemView>) => setView((v) => ({ ...v, ...p })), []);

  const working = useRef(false);
  const stage = useRef<Stage>("loading");
  const seatRef = useRef<0 | 1 | null>(null);
  const shownKey = useRef("");
  const holeHand = useRef(-1);
  const activeSince = useRef(0);
  const closingSince = useRef(0);
  const lastCommit = useRef(0);
  const commitSince = useRef(0);
  const commitFailures = useRef(0);
  const contributedHand = useRef(0);
  const contributedAt = useRef(0);
  const lastVrf = useRef(0);
  const settledSeen = useRef(false);
  const finalRead = useRef(false);
  const assignRef = useRef<Assignment | null>(null);
  const failures = useRef(0);

  const mk = useMemo(() => (id === null ? null : matchAddressOf(id)), [id]);
  const p = useMemo(() => (signer ? (signer as unknown as PlayerSigner) : null), [signer]);

  const setStage = useCallback((s: Stage, note = "") => {
    stage.current = s;
    setView((v) => (v.stage === s && v.note === note ? v : { ...v, stage: s, note }));
  }, []);

  const addSig = useCallback((label: string, sig: string | undefined, layer: "base" | "tee") => {
    if (sig) setView((v) => (v.sigs.some((x) => x.sig === sig) ? v : { ...v, sigs: [...v.sigs, { label, sig, layer }] }));
  }, []);

  const applyTable = useCallback((t: Table) => {
    const k = tableKey(t);
    if (k === shownKey.current) return;
    shownKey.current = k;
    setView((v) => ({ ...v, table: t }));
  }, []);

  // Every confirmed step of this Match, with its layer, for the Transactions list.
  useEffect(() => {
    const hd = getHoldem();
    hd.onTx = (label, layer, sig) => addSig(label, sig, layer);
    return () => {
      hd.onTx = undefined;
    };
  }, [addSig]);

  // -- the driver (sequential; one step per tick) --------------------------------------------

  /**
   * Settles from the committed table once base has the result. One Player settles at once (the winner; seat 0 for a refund), the
   * other waits and settles only if the Match is still open then, so the loser of a race does not burn a fee.
   */
  const settle = useCallback(
    async (a: Assignment, seat: 0 | 1, t: Table | null) => {
      if (!p || !signer || id === null) return;
      const hd = getHoldem();
      if (!closingSince.current) closingSince.current = now();
      const refund = !t || t.status === STATUS.cancelled || t.winner === NO_WINNER;
      const mine = refund ? seat === 0 : t!.winner === seat;
      if (!mine && now() - closingSince.current < FINALIZE_GRACE_MS) return;
      const base = await hd.readTableOnBase(a);
      if (!base || !canFinalizeTable(base, a, Date.now() / 1000)) return;
      setView((v) => (v.commit ? { ...v, commit: null } : v));
      try {
        await finalizeFree(hd, signer, () => tokenRef.current(), a);
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
    const hd = getHoldem();
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
        const a = await hd.readAssignment(mk!);
        const t = a ? await hd.readTableOnBase(a) : null;
        if (t) setView((v) => ({ ...v, table: t }));
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
    const late = now() - activeSince.current >= (seat === 1 ? 0 : 12_000);
    const a = await hd.readAssignment(mk!);
    if (!a) return setStage("setup", setupNote(m));
    assignRef.current = a;
    const t = await hd.readTable(p, a);
    if (!t) return setStage("setup", "Setting up the Match");
    const nowS = Date.now() / 1000;
    // An idle table receives its Match key in begin_match, after the Assignment exists.
    if (t.tablePhase === TABLE_PHASE.idle && atAssignedEpoch(a, t)) {
      setStage("setup", "Starting the Match");
      if (late && nowS <= a.startDeadline) await hd.beginMatch(p, a).catch(() => undefined);
      return;
    }
    if (!tableOf(a, t)) {
      // The table has been wiped for its next Match: the result lives in the committed ring.
      setStage("closing", "Paying out the Pot");
      return settle(a, seat, null);
    }
    applyTable(t);
    if (t.tablePhase === TABLE_PHASE.waiting) {
      if (nowS > t.startDeadline) {
        // Never both checked in: the Player who came wins, nobody coming is a no-show.
        setStage("setup", absenceLine(t.checkedIn, seat));
        if (seat === 1 || now() - activeSince.current > GRACE_MS) await hd.expireStart(p, a).catch(() => undefined);
        return;
      }
      if (!t.seatsOpen) {
        setStage("setup", "Creating your session");
        if (late) await hd.seatPlayers(p, a).catch(() => undefined);
        return;
      }
      if (!t.checkedIn[seat]) {
        setStage("setup", "Joining the Match");
        await hd.checkIn(p, a);
        return;
      }
      setStage("setup", "Waiting for your opponent");
      return;
    }

    if (t.tablePhase === TABLE_PHASE.live) {
      setStage("live");
      if (t.phase === PHASE.shuffle) await shuffle(a, t, seat);
      return;
    }

    // Over: commit the public result, then settle from the committed ring.
    setStage("closing", "Saving the result");
    if (!closingSince.current) closingSince.current = now();
    const refund = t.status === STATUS.cancelled || t.winner === NO_WINNER;
    const mine = refund ? seat === 0 : t.winner === seat;
    if (t.dirty) {
      if (!mine && now() - closingSince.current < 15_000) return;
      if (now() - lastCommit.current < 10_000) return;
      lastCommit.current = now();
      try {
        await hd.commitTable(p, a);
        commitFailures.current = 0;
      } catch (e) {
        // The other Player committed first, or the commit is already in flight: only other errors count.
        if (!/NotDirty/.test(String(e)) && ++commitFailures.current >= 3) throw e;
        if (!/NotDirty/.test(String(e))) return;
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
    await settle(a, seat, t);

    async function shuffle(ref: Assignment, tb: Table, s: 0 | 1) {
      if (!p || id === null) return;
      // The secret is sent once per hand: a retry would send a second one, so the seat is asked first.
      if (contributedHand.current !== tb.handNo) {
        if (!(await hd.hasContributed(p, ref, s))) {
          await hd.contributeEntropy(p, ref, s, false);
        }
        contributedHand.current = tb.handNo;
        contributedAt.current = now();
        return;
      }
      if (tb.vrfReady) {
        await hd.deal(p, ref).catch(() => undefined);
        return;
      }
      // The request is made once per hand (the program refuses a second one): seat 1 asks, seat 0 only if that stalls.
      if (!tb.reqPending && (s === 1 || now() - contributedAt.current > 6_000) && now() - lastVrf.current > 5_000) {
        lastVrf.current = now();
        try {
          await hd.requestVrf(p, ref);
        } catch {
          // Refused until the other Player's secret is in, or the other Player asked first.
        }
      }
    }
  }, [p, signer, id, mk, setStage, applyTable, onSettled, settle]);

  const tick = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      await step();
      setView((v) => (v.error ? { ...v, error: null } : v));
    } catch (e) {
      patch({ error: errText(e) });
    } finally {
      working.current = false;
    }
  }, [step, patch]);

  useEffect(() => {
    if (!p || id === null) return;
    const first = setTimeout(() => void tick(), 0);
    const t = setInterval(() => void tick(), 1500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [p, id, tick]);

  // -- the reader (fast, independent of the driver) -------------------------------------------

  useEffect(() => {
    if (!p || id === null) return;
    let stop = false;
    let busy = false;
    const poll = async () => {
      const seat = seatRef.current;
      const a = assignRef.current;
      if (busy || stop || seat === null || !a || !["live", "closing", "setup"].includes(stage.current)) return;
      busy = true;
      try {
        const hd = getHoldem();
        const t = await hd.readTable(p, a);
        if (!t || stop || !tableOf(a, t)) return;
        applyTable(t);
        if (t.phase >= PHASE.preflop && t.phase <= PHASE.river && holeHand.current !== t.handNo) {
          const h = await hd.readOwnHole(p, a, seat);
          if (h && !stop) {
            holeHand.current = h.handNo;
            setView((v) => ({ ...v, hole: h }));
          }
        }
      } catch {
        // The driver reports persistent failures; a missed poll is retried.
      } finally {
        busy = false;
      }
    };
    const t = setInterval(() => void poll(), 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [p, id, mk, applyTable]);

  // -- Player decisions -----------------------------------------------------------------------

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      patch({ busy: label, error: null });
      try {
        const sig = await fn();
        // Rollup steps were logged by the client; this catches base-layer ones (refund).
        if (sig) addSig(label, sig, "base");
        const a = assignRef.current;
        if (p && id !== null && a) {
          const t = await getHoldem().readTable(p, a);
          if (t) applyTable(t);
        }
      } catch (e) {
        patch({ error: errText(e) });
      } finally {
        patch({ busy: null });
      }
    },
    [p, id, patch, addSig, applyTable],
  );

  const act = useCallback((action: Action, label: string) => run(label, () => getHoldem().act(p!, assignRef.current!, action)), [p, run]);
  const claimTimeout = useCallback(() => run("claim_timeout", () => getHoldem().claimTimeout(p!, assignRef.current!)), [p, run]);

  return { view, act, claimTimeout, tick, run };
}
