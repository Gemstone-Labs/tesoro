"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain, getTradingDuel } from "@/lib/chain/client";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { ASSETS, DRAW, STATUS, TRADING_DUEL_PROGRAM_ID, addresses, assetOfMatchId, decodeDuel, type Asset, type Book, type Duel, type PlayerSigner } from "./chain";
import { addSighting, clockOffsetMs, dropPending, settlePending, type ClockSighting, type PendingPicks } from "./matchView";
import { plainError } from "@/lib/errors";

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
const duelKey = (d: Duel) => [d.status, d.winner, d.startsAt, d.endsAt, d.lastTick, d.scores, d.revealed, d.track.seen, d.track.lo, d.track.hi, d.track.last].join("|");
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
 * Drives one Trading Duel for one Player: creates and delegates the Duel, starts it, reads the
 * public Duel and your own Book from the private rollup, cranks `tick` about four times a second while
 * the grid runs, ends it when the window closes, then commits it back and settles. Both Players'
 * clients run the same driver; steps either Player may do are tried by one client first and by the
 * other after a grace period, and a lost race is harmless because every step re-reads chain state.
 * Picks are signed by the Account's wallet signer without a prompt (embedded or dev wallet), as in
 * Hold'em, and show at once; a refused pick is rolled back with a plain error.
 */
export function useDuelMatch(id: bigint | null, signer: ChainSigner | null, onSettled?: () => void) {
  const asset = useMemo(() => (id === null ? ASSETS[0] : (assetOfMatchId(id) ?? ASSETS[0])), [id]);
  const [view, setView] = useState<DuelView>({
    stage: "loading",
    match: null,
    seat: null,
    asset,
    duel: null,
    book: null,
    pending: {},
    note: "",
    error: null,
    sigs: [],
    busy: null,
    refundable: false,
    clockOffsetMs: 0,
  });
  const patch = useCallback((p: Partial<DuelView>) => setView((v) => ({ ...v, ...p })), []);

  const working = useRef(false);
  const stage = useRef<Stage>("loading");
  const seatRef = useRef<0 | 1 | null>(null);
  const delegated = useRef(false);
  const shownDuel = useRef("");
  const shownBook = useRef("");
  const activeSince = useRef(0);
  const closingSince = useRef(0);
  const lastClose = useRef(0);
  const duelRef = useRef<Duel | null>(null);
  const offsetRef = useRef(0);
  const sightings = useRef<ClockSighting[]>([]);
  const pendingRef = useRef<PendingPicks>({});
  const pickQueue = useRef<Promise<unknown>>(Promise.resolve());
  const settledSeen = useRef(false);
  const finalRead = useRef(false);
  const failures = useRef(0);

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

  const step = useCallback(async () => {
    if (!p || !signer || id === null) return;
    const td = getTradingDuel();
    const ad = addresses(id);
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
        const d = await td.readDuelOnBase(id);
        setView((v) => ({ ...v, duel: d ?? v.duel }));
      }
      if (!settledSeen.current) {
        settledSeen.current = true;
        onSettled?.();
      }
      return;
    }

    // Active: the Duel has to exist, live on the rollup, and be started.
    if (!activeSince.current) activeSince.current = now();
    // The joiner sets the Duel up; the opener steps in if that stalls.
    const late = now() - activeSince.current >= (seat === 1 ? 0 : 12_000);
    const info = await td.base.getAccountInfo(ad.duel);

    if (!info) {
      setStage("setup", "Setting up the Match");
      if (!late || !m.opponent) return;
      const core = getChain().core;
      const opp = (await core.account.tesoroAccount.fetch(new PublicKey(m.opponent))) as unknown as { authority: PublicKey };
      const [a, b] = seat === 0 ? [signer.publicKey, opp.authority] : [opp.authority, signer.publicKey];
      await td.createDuel(p, id, a, b);
      return;
    }

    if (info.owner.equals(TRADING_DUEL_PROGRAM_ID)) {
      const d = decodeDuel(ad.duel, td.program.coder.accounts.decode("duel", info.data));
      if (d.status === STATUS.created) {
        setStage("setup", "Creating your session");
        if (!late) return;
        await td.delegateDuel(p, id);
        return;
      }
      // Committed back after the Match ended: settle.
      delegated.current = false;
      setView((v) => ({ ...v, duel: d }));
      setStage("closing", "Paying out the Pot");
      if (!closingSince.current) closingSince.current = now();
      // The winner settles at once (seat 0 for a draw or a cancelled Duel); the other waits, so the loser of a race burns no fee.
      const mine = d.status === STATUS.cancelled || d.winner === DRAW ? seat === 0 : d.winner === seat;
      if (!mine && now() - closingSince.current < GRACE_MS) return;
      try {
        await td.finalize(p, id);
      } catch (e) {
        const again = await fetchMatch(id, me);
        if (again && (again.status === "settled" || again.status === "refunded")) return;
        if (++failures.current >= 3) throw e;
      }
      return;
    }

    if (!info.owner.equals(DELEGATION_PROGRAM_ID)) return;
    delegated.current = true;
    const d = await td.readDuel(p, id);
    if (!d) return setStage("setup", "Creating your session");
    applyDuel(d);

    if (d.status === STATUS.created) {
      if ((Date.now() + offsetRef.current) / 1000 > d.startDeadline) {
        // Delegated but never started in time: cancel it so both entries can be refunded.
        setStage("setup", "The Duel was never started: cancelling");
        if (seat === 1 || now() - activeSince.current > GRACE_MS) await td.claimTimeout(p, id).catch(() => undefined);
        return;
      }
      setStage("setup", "Starting the Match");
      if (!late) return;
      try {
        await td.start(p, id, d.asset);
      } catch (e) {
        if ((await td.readDuel(p, id))?.status === STATUS.created) throw e;
      }
      return;
    }

    if (d.status === STATUS.live) {
      // The cranking runs on its own loop below.
      setStage("live");
      return;
    }

    // Over or cancelled: close the permissions and commit everything back.
    setStage("closing", "Saving the result");
    if (!closingSince.current) closingSince.current = now();
    const mine = d.status === STATUS.cancelled || d.winner === DRAW ? seat === 0 : d.winner === seat;
    if (!mine && now() - closingSince.current < GRACE_MS) return;
    if (now() - lastClose.current < 30_000) return;
    lastClose.current = now();
    try {
      await td.closeMatch(p, id);
    } catch {
      // The other Player closed it first, or the commit is still in flight.
    }
  }, [p, signer, id, setStage, applyDuel, onSettled]);

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
      if (busy || stop || seat === null || !delegated.current || !["live", "closing", "setup"].includes(stage.current)) return;
      busy = true;
      try {
        const td = getTradingDuel();
        const [d, b] = await Promise.all([td.readDuel(p, id), td.readOwnBook(p, id, seat)]);
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
  }, [p, id, applyDuel, applyBook]);

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
      if (sending || stop || !d || seat === null || stage.current !== "live" || d.status !== STATUS.live || now() < waitUntil) return;
      const nowS = (Date.now() + offsetRef.current) / 1000;
      if (nowS < d.startsAt) return;
      sending = true;
      try {
        const td = getTradingDuel();
        if (nowS < d.endsAt) {
          // Records the live price into the line and reveals the columns that locked; a stale price just refuses it.
          await td.tick(p, id, d.asset);
          failures = 0;
        } else {
          // The window is over: end it. The result is the same whoever does it and whenever, so seat 1 tries right away, seat 0 a couple of seconds later, and both retry every second.
          if (!endSince) endSince = now();
          if (seat === 1 || now() - endSince >= END_GRACE_MS) await td.end(p, id);
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
  }, [p, id]);

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
      if (!p || id === null || seat === null) return;
      const set = (next: PendingPicks) => {
        pendingRef.current = next;
        setView((v) => ({ ...v, pending: next }));
      };
      set({ ...pendingRef.current, [column]: band });
      patch({ error: null });
      pickQueue.current = pickQueue.current.then(async () => {
        const td = getTradingDuel();
        try {
          await td.setPick(p, id, seat, column, band);
          const b = await td.readOwnBook(p, id, seat);
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
