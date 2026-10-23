"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getTradingDuel } from "@/lib/chain/client";
import { matchAddressOf } from "@/lib/chain/match-id";
import { NO_TABLE_NOTE } from "@/lib/chain/match-status";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { ASSETS, DRAW, PHASE, STATUS, assetOfIndex, decodeDuel, type Assignment, type Asset, type Book, type Duel, type PlayerSigner } from "./chain";
import { addSighting, canFinalize, clockOffsetMs, dropPending, settlePending, type ClockSighting, type PendingPicks } from "./matchView";
import { commitPhase, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { plainError } from "@/lib/errors";
import { absenceLine } from "@/lib/absence-copy";

/** Where a Trading Duel Match is in its life, read from chain. */
export type Stage = "loading" | "notfound" | "spectator" | "waiting" | "setup" | "live" | "closing" | "settled";

export interface DuelView {
  stage: Stage;
  match: ChainMatch | null;
  seat: 0 | 1 | null;
  asset: Asset;
  /** The public Duel from the private rollup (the committed one once the Match is over). */
  duel: Duel | null;
  /** Your own Book (your picks), read with your TEE token. */
  book: Book | null;
  /** Picks you made that the rollup has not confirmed yet; rolled back with an error if refused. */
  pending: PendingPicks;
  note: string;
  error: string | null;
  sigs: { label: string; sig: string; layer: "base" | "tee" }[];
  busy: string | null;
  /** The tesoro_core refund deadline passed on an unfinished Match. */
  refundable: boolean;
  /** The result is in and waiting to be committed to the chain (the Match is over, the rollup has not handed it back). */
  commit: CommitState | null;
  /** How far the rollup's clock runs ahead of this browser's, ms (add it to `Date.now()`). */
  clockOffsetMs: number;
}

const errText = plainError;

/** A refused pick in words: the column locked a moment ago, or the session did not answer. */
function pickError(e: unknown): string {
  return /ColumnLocked|GridClosed/.test(String(e)) ? "That column just locked, so the pick didn’t count." : errText(e);
}
const now = () => Date.now();


/** A key that changes whenever anything a Player can see in the Duel changes. */
const duelKey = (d: Duel) => [d.status, d.winner, d.checkedIn, d.seatsOpen, d.dirty, d.startsAt, d.endsAt, d.lastTick, d.scores, d.revealed, d.track.seen, d.track.lo, d.track.hi, d.track.last].join("|");
const bookKey = (b: Book) => b.picks.join(",");

/** How long the Player who does not act at once waits before doing a step either Player may do. */
const GRACE_MS = 15_000;
/** Seconds after the window closes before the second Player also tries to end the Match (the result is the same whoever does it). */
const END_GRACE_MS = 2_000;
/** The grid is cranked about four times a second while it runs: a denser line is a truer one. A call is never sent while the last is in flight. */
const TICK_EVERY_MS = 250;
/** After a failed call the next waits this long, doubling per failure up to the cap (a stale price or a lost race is not worth hammering the rollup for). */
const BACKOFF_MS = 500;
const BACKOFF_MAX_MS = 4_000;
/** The end retries at least this often, so a slow Match does not wait long on it. */
const END_BACKOFF_MAX_MS = 1_000;

/**
 * Drives one Trading Duel for one Player on its persistent table: waits for the operator to assign the
 * Match to a table, begins it, opens the seats, checks in, reads the table and your own Book from the
 * private rollup, cranks `tick` about four times a second while the grid runs, ends it when the window
 * closes, commits the result and settles from the committed ring. Closing the seats and resetting the
 * table is the keeper's table scheduler. Both Players'
 * clients run the same driver; steps either Player may do are tried by one client first and by the
 * other after a grace period, and a lost race is harmless because every step re-reads chain state.
 * Picks are signed by the Account's wallet signer without a prompt (embedded or dev wallet), as in
 * Hold'em, and show at once; a refused pick is rolled back with a plain error.
 */
export function useDuelMatch(id: string | null, signer: ChainSigner | null, onSettled?: () => void) {
  const [view, setView] = useState<DuelView>({
    stage: "loading",
    match: null,
    seat: null,
    asset: ASSETS[0],
    duel: null,
    book: null,
    pending: {},
    note: "",
    error: null,
    sigs: [],
    busy: null,
    refundable: false,
    commit: null,
    clockOffsetMs: 0,
  });
  const patch = useCallback((p: Partial<DuelView>) => setView((v) => ({ ...v, ...p })), []);

  const working = useRef(false);
  const stage = useRef<Stage>("loading");
  const seatRef = useRef<0 | 1 | null>(null);
  const assignRef = useRef<Assignment | null>(null);
  const shownDuel = useRef("");
  const shownBook = useRef("");
  const activeSince = useRef(0);
  const closingSince = useRef(0);
  const lastCommit = useRef(0);
  const commitSince = useRef(0);
  const commitFailures = useRef(0);
  const duelRef = useRef<Duel | null>(null);
  const offsetRef = useRef(0);
  const sightings = useRef<ClockSighting[]>([]);
  const pendingRef = useRef<PendingPicks>({});
  const pickQueue = useRef<Promise<unknown>>(Promise.resolve());
  const settledSeen = useRef(false);
  const finalRead = useRef(false);
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

  const applyDuel = useCallback((d: Duel) => {
    const k = duelKey(d);
    if (k === shownDuel.current) return;
    shownDuel.current = k;
    duelRef.current = d;
    // Each new stamp the rollup puts on a tick tells where its clock is; keep the offset steady unless it moves.
    sightings.current = addSighting(sightings.current, { rollupS: d.lastTick, seenMs: Date.now() });
    const offset = clockOffsetMs(sightings.current);
    const moved = Math.abs(offset - offsetRef.current) >= 250;
    if (moved) offsetRef.current = offset;
    setView((v) => ({ ...v, duel: d, clockOffsetMs: moved ? offset : v.clockOffsetMs }));
  }, []);

  const applyBook = useCallback((b: Book) => {
    const k = bookKey(b);
    if (k === shownBook.current) return;
    shownBook.current = k;
    const pending = settlePending(pendingRef.current, b);
    pendingRef.current = pending;
    setView((v) => ({ ...v, book: b, pending }));
  }, []);

  // Every confirmed step of this Match, with its layer, for the Transactions list.
  useEffect(() => {
    const td = getTradingDuel();
    td.onTx = (label, layer, sig) => addSig(label, sig, layer);
    return () => {
      td.onTx = undefined;
    };
  }, [addSig]);

  // -- the driver (sequential; one step per tick) --------------------------------------------

  /**
   * Settles from the committed table once base has the result. The winner settles at once (seat 0 for a draw or a Match that
   * never started); the other waits, so the loser of a race burns no fee. Until the commit lands there is nothing to settle from.
   */
  const settle = useCallback(
    async (a: Assignment, seat: 0 | 1, d: Duel | null) => {
      if (!p || !signer || id === null || mk === null) return;
      const td = getTradingDuel();
      if (!closingSince.current) closingSince.current = now();
      const mine = !d ? seat === 0 : d.status === STATUS.cancelled || d.winner === DRAW ? seat === 0 : d.winner === seat;
      if (!mine && now() - closingSince.current < GRACE_MS) return;
      const base = await td.readTableOnBase(a);
      if (!base || !canFinalize(base, a, Date.now() / 1000)) return;
      setView((v) => (v.commit ? { ...v, commit: null } : v));
      try {
        await td.finalize(p, a);
      } catch (e) {
        const again = await fetchMatch(id, BlockPuzzleChain.coreAccount(signer.publicKey));
        if (again && (again.status === "settled" || again.status === "refunded")) return;
        if (++failures.current >= 3) throw e;
      }
    },
    [p, signer, id, mk],
  );

  const step = useCallback(async () => {
    if (!p || !signer || id === null || mk === null) return;
    const td = getTradingDuel();
      const me = BlockPuzzleChain.coreAccount(signer.publicKey);
    const m = await fetchMatch(id, me);
    setView((v) => ({ ...v, match: m, asset: (m && assetOfIndex(m.asset)) || v.asset, refundable: !!m && m.status === "active" && Date.now() / 1000 > m.deadline }));
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
        const a = await td.readAssignment(mk!);
        const d = a ? await td.readDuelOnBase(a) : null;
        setView((v) => ({ ...v, duel: d ?? v.duel }));
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
    const a = await td.readAssignment(mk!);
    if (!a) {
      setStage("setup", NO_TABLE_NOTE);
      return;
    }
    assignRef.current = a;
    const t = await td.readTable(p, a);
    if (!t) return setStage("setup", "Setting up the Match");
    const d = decodeDuel(a, t);
    if (!d && t.phase === PHASE.idle && t.epoch === a.epoch) {
      // Assigned, not begun: the table is Idle at the Match's epoch. Begin only inside the start window (the program refuses later).
      if ((Date.now() + offsetRef.current) / 1000 > a.startDeadline) return setStage("setup", "The Match was never started: the entries come back soon");
      setStage("setup", "Starting the Match");
      if (late) await td.beginMatch(p, a).catch(() => undefined);
      return;
    }
    if (!d) {
      // The table has been wiped for its next Match: the result lives in the committed ring.
      setStage("closing", "Paying out the Pot");
      return settle(a, seat, null);
    }
    applyDuel(d);
    const nowS = (Date.now() + offsetRef.current) / 1000;

    if (d.status === STATUS.created) {
      if (t.phase === 1 && nowS > d.startDeadline) {
        // Never both checked in: the Player who came wins, nobody coming is a no-show.
        setStage("setup", absenceLine(t.checkedIn, seat));
        if (seat === 1 || now() - activeSince.current > GRACE_MS) await td.expireStart(p, a).catch(() => undefined);
        return;
      }
      if (!t.seatsOpen) {
        setStage("setup", "Creating your session");
        if (late) await td.openSeats(p, a).catch(() => undefined);
        return;
      }
      if (!t.checkedIn[seat]) {
        setStage("setup", "Joining the Match");
        await td.checkIn(p, a, d.asset);
        return;
      }
      setStage("setup", "Waiting for your opponent");
      return;
    }

    if (d.status === STATUS.live) {
      // The cranking runs on its own loop below.
      setStage("live");
      return;
    }

    // Over (or never started): commit the result, then settle from the committed ring.
    setStage("closing", "Saving the result");
    if (!closingSince.current) closingSince.current = now();
    const mine = d.status === STATUS.cancelled || d.winner === DRAW ? seat === 0 : d.winner === seat;
    if (d.dirty) {
      if (!mine && now() - closingSince.current < GRACE_MS) return;
      if (now() - lastCommit.current < 10_000) return;
      lastCommit.current = now();
      try {
        await td.commitTable(p, a);
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
    await settle(a, seat, d);
  }, [p, signer, id, mk, setStage, applyDuel, onSettled, settle]);

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
        const td = getTradingDuel();
        const [d, b] = await Promise.all([td.readDuel(p, a), td.readOwnBook(p, a, seat)]);
        if (stop) return;
        if (d) applyDuel(d);
        if (b) applyBook(b);
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
  }, [p, id, mk, applyDuel, applyBook]);

  // -- the crank: tick every quarter second through the grid, then end it ---------------------------

  useEffect(() => {
    if (!p || id === null) return;
    let stop = false;
    let sending = false;
    let endSince = 0;
    let failures = 0;
    let waitUntil = 0;
    const crank = async () => {
      const d = duelRef.current;
      const seat = seatRef.current;
      const a = assignRef.current;
      if (sending || stop || !d || !a || seat === null || stage.current !== "live" || d.status !== STATUS.live || now() < waitUntil) return;
      const nowS = (Date.now() + offsetRef.current) / 1000;
      if (nowS < d.startsAt) return;
      sending = true;
      try {
        const td = getTradingDuel();
        if (nowS < d.endsAt) {
          // Records the live price into the line and reveals the columns that locked; a stale price just refuses it.
          await td.tick(p, a, d.asset);
          failures = 0;
        } else {
          // The window is over: end it. The result is the same whoever does it and whenever, so seat 1 tries right away, seat 0 a couple of seconds later, and both retry every second.
          if (!endSince) endSince = now();
          if (seat === 1 || now() - endSince >= END_GRACE_MS) await td.end(p, a);
          failures = 0;
        }
      } catch {
        // A stale price (a tick) or a rollup clock a moment behind (the end) is retried after a growing pause, or the other Player did it first.
        const cap = nowS < d.endsAt ? BACKOFF_MAX_MS : END_BACKOFF_MAX_MS;
        waitUntil = now() + Math.min(cap, BACKOFF_MS * 2 ** failures++);
      } finally {
        sending = false;
      }
    };
    const t = setInterval(() => void crank(), TICK_EVERY_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [p, id, mk]);

  // -- Player decisions -----------------------------------------------------------------------

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      patch({ busy: label, error: null });
      try {
        const sig = await fn();
        if (sig) addSig(label, sig, "base");
      } catch (e) {
        patch({ error: errText(e) });
      } finally {
        patch({ busy: null });
      }
    },
    [patch, addSig],
  );

  /**
   * Picks `band` for `column` (`NO_PICK` clears it). The pick shows at once; picks are sent in order,
   * and a refused one is taken back with a plain error.
   */
  const pick = useCallback(
    (column: number, band: number) => {
      const seat = seatRef.current;
      const a = assignRef.current;
      if (!p || id === null || seat === null || !a) return;
      const set = (next: PendingPicks) => {
        pendingRef.current = next;
        setView((v) => ({ ...v, pending: next }));
      };
      set({ ...pendingRef.current, [column]: band });
      patch({ error: null });
      pickQueue.current = pickQueue.current.then(async () => {
        const td = getTradingDuel();
        try {
          await td.setPick(p, a, seat, column, band);
          const b = await td.readOwnBook(p, a, seat);
          if (b) applyBook(b);
          // Confirmed: the Book is the truth now, unless a newer pick for the column is in flight.
          if (pendingRef.current[column] === band) {
            set(dropPending(pendingRef.current, column));
          }
        } catch (e) {
          if (pendingRef.current[column] === band) {
            set(dropPending(pendingRef.current, column));
          }
          patch({ error: pickError(e) });
        }
      });
    },
    [p, id, patch, applyBook],
  );

  return { view, pick, run, tick };
}
