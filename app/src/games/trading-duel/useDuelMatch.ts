"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain, getTradingDuel } from "@/lib/chain/client";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { ASSETS, DRAW, STATUS, TRADING_DUEL_PROGRAM_ID, addresses, assetOfMatchId, decodeDuel, type Asset, type Book, type Duel, type PlayerSigner } from "./chain";

/** Where a Trading Duel Match is in its life, read from chain. */
export type Stage = "loading" | "notfound" | "spectator" | "waiting" | "setup" | "live" | "closing" | "settled";

export interface DuelView {
  stage: Stage;
  match: ChainMatch | null;
  seat: 0 | 1 | null;
  asset: Asset;
  /** The public Duel from the private rollup (the committed one once the Match is over). */
  duel: Duel | null;
  /** Your own Book, read with your TEE token. */
  book: Book | null;
  /** Both Books once committed to the base layer: public, with every fill. */
  finalBooks: [Book, Book] | null;
  note: string;
  error: string | null;
  sigs: { label: string; sig: string; layer: "base" | "tee" }[];
  busy: string | null;
  /** The tesoro_core refund deadline passed on an unfinished Match. */
  refundable: boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const now = () => Date.now();

/** A key that changes whenever anything a Player can see in the Duel changes. */
const duelKey = (d: Duel) => [d.status, d.lead, d.trades, d.winner, d.startsAt, d.endsAt, d.finalPrice].join("|");
const bookKey = (b: Book) => [b.cash, b.side, b.margin, b.entry, b.fillCount, b.liquidations].join("|");

/** How long the Player who does not act at once waits before doing a step either Player may do. */
const GRACE_MS = 15_000;
/** Seconds after the window closes before the second Player also tries to end the Match. */
const END_GRACE_MS = 6_000;
const TICK_EVERY_MS = 4_000;

/**
 * Drives one Trading Duel for one Player: creates and delegates the Duel, starts it, reads the
 * public Duel and your own Book from the private rollup, cranks `tick` while it runs, ends it when
 * the window closes, then commits it back and settles. Both Players' clients run the same driver;
 * steps either Player may do are tried by one client first and by the other after a grace period,
 * and a lost race is harmless because every step re-reads chain state. Trades are signed by the
 * Account's wallet signer without a prompt (embedded or dev wallet), as in Hold'em.
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
    finalBooks: null,
    note: "",
    error: null,
    sigs: [],
    busy: null,
    refundable: false,
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
  const lastTick = useRef(0);
  const lastEnd = useRef(0);
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
    setView((v) => ({ ...v, duel: d }));
  }, []);

  const applyBook = useCallback((b: Book) => {
    const k = bookKey(b);
    if (k === shownBook.current) return;
    shownBook.current = k;
    setView((v) => ({ ...v, book: b }));
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
        const [d, books] = await Promise.all([td.readDuelOnBase(id), td.readBooksOnBase(id)]);
        setView((v) => ({ ...v, duel: d ?? v.duel, finalBooks: books }));
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
      setStage("setup", "Creating the Duel on Solana devnet");
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
        setStage("setup", "Moving the Duel to the private rollup");
        if (!late) return;
        await td.delegateDuel(p, id);
        return;
      }
      // Committed back after the Match ended: settle.
      delegated.current = false;
      setView((v) => ({ ...v, duel: d }));
      setStage("closing", "Settling on Solana devnet");
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
    if (!d) return setStage("setup", "Waiting for the private Duel");
    applyDuel(d);

    if (d.status === STATUS.created) {
      if (Date.now() / 1000 > d.startDeadline) {
        // Delegated but never started in time: cancel it so both entries can be refunded.
        setStage("setup", "The Duel was never started: cancelling");
        if (seat === 1 || now() - activeSince.current > GRACE_MS) await td.claimTimeout(p, id).catch(() => undefined);
        return;
      }
      setStage("setup", "Starting the Match");
      if (!late) return;
      try {
        await td.start(p, id);
      } catch (e) {
        if ((await td.readDuel(p, id))?.status === STATUS.created) throw e;
      }
      return;
    }

    if (d.status === STATUS.live) {
      setStage("live");
      const nowS = Date.now() / 1000;
      if (nowS >= d.endsAt) {
        // The window is over: end it on the first oracle price published after the close. Seat 1 first, seat 0 a few seconds later.
        if (!closingSince.current) closingSince.current = now();
        const wait = seat === 1 ? 0 : END_GRACE_MS;
        if (nowS * 1000 - d.endsAt * 1000 < wait || now() - lastEnd.current < 2_500) return;
        lastEnd.current = now();
        try {
          await td.end(p, id, d.asset);
        } catch {
          // Refused until a price published after the close arrives, or the other Player ended it first.
        }
      } else if (nowS >= d.startsAt && now() - lastTick.current >= TICK_EVERY_MS) {
        lastTick.current = now();
        // Executes due liquidations and refreshes the lead; a stale price just refuses it.
        await td.tick(p, id, d.asset).catch(() => undefined);
      }
      return;
    }

    // Over or cancelled: close the permissions and commit everything back.
    setStage("closing", "Committing the Duel to Solana devnet");
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

  // -- Player decisions -----------------------------------------------------------------------

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      patch({ busy: label, error: null });
      try {
        const sig = await fn();
        if (sig) addSig(label, sig, "base");
        const seat = seatRef.current;
        if (p && id !== null && seat !== null) {
          const td = getTradingDuel();
          const [d, b] = await Promise.all([td.readDuel(p, id), td.readOwnBook(p, id, seat)]);
          if (d) applyDuel(d);
          if (b) applyBook(b);
        }
      } catch (e) {
        patch({ error: errText(e) });
      } finally {
        patch({ busy: null });
      }
    },
    [p, id, patch, addSig, applyDuel, applyBook],
  );

  const open = useCallback((side: 1 | 2, margin: bigint, leverage: number) => run("Opening", () => getTradingDuel().open(p!, id!, asset, side, margin, leverage)), [p, id, asset, run]);
  const close = useCallback(() => run("Closing", () => getTradingDuel().close(p!, id!, asset)), [p, id, asset, run]);
  const flip = useCallback((side: 1 | 2, margin: bigint, leverage: number) => run("Flipping", () => getTradingDuel().flip(p!, id!, asset, side, margin, leverage)), [p, id, asset, run]);

  return { view, open, close, flip, run, tick };
}
