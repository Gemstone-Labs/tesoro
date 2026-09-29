"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getHoldem } from "@/lib/chain/client";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import {
  HOLDEM_PROGRAM_ID,
  PHASE,
  SPEED_TURBO,
  STATUS,
  addresses,
  decodeTable,
  type Action,
  type PlayerSigner,
  type Table,
} from "./chain";

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
}

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const now = () => Date.now();

/** A key that changes whenever anything a Player can see changes. */
function tableKey(t: Table): string {
  return [t.status, t.handNo, t.phase, t.toAct, t.deadline, t.stacks, t.bets, t.committed, t.board, t.lastHand.handNo, t.winner, t.missed].join("|");
}

/**
 * Drives one Hold'em Match for one Player: reads the table from the private rollup, and does
 * every step that is not a betting decision (create and delegate the table, start it, per-hand
 * entropy + VRF + deal, close and settle). Both Players' clients run the same driver; steps that
 * either Player may do are tried by one client first and by the other after a grace period, and
 * a lost race is harmless because each step re-reads chain state.
 */
export function useHoldemMatch(id: bigint | null, signer: ChainSigner | null, onSettled?: () => void) {
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
  });
  const patch = useCallback((p: Partial<HoldemView>) => setView((v) => ({ ...v, ...p })), []);

  const working = useRef(false);
  const stage = useRef<Stage>("loading");
  const seatRef = useRef<0 | 1 | null>(null);
  const shownKey = useRef("");
  const holeHand = useRef(-1);
  const activeSince = useRef(0);
  const closingSince = useRef(0);
  const lastClose = useRef(0);
  const contributedHand = useRef(0);
  const contributedAt = useRef(0);
  const lastVrf = useRef(0);
  const settledSeen = useRef(false);
  const finalRead = useRef(false);
  const delegated = useRef(false);
  const failures = useRef(0);

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

  const step = useCallback(async () => {
    if (!p || !signer || id === null) return;
    const hd = getHoldem();
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
        const t = await hd.readTableOnBase(id);
        if (t) setView((v) => ({ ...v, table: t }));
      }
      if (!settledSeen.current) {
        settledSeen.current = true;
        onSettled?.();
      }
      return;
    }

    // Active: the table has to exist, live on the rollup, and be started.
    if (!activeSince.current) activeSince.current = now();
    // The joiner sets the table up; the opener steps in if that stalls.
    const late = now() - activeSince.current >= (seat === 1 ? 0 : 12_000);
    const info = await hd.base.getAccountInfo(ad.gameMatch);

    if (!info) {
      setStage("setup", "Creating the table on Solana devnet");
      if (!late) return;
      const opponentAccount = m.opponent;
      if (!opponentAccount) return;
      const { PublicKey } = await import("@solana/web3.js");
      const core = (await import("@/lib/chain/client")).getChain().core;
      const opp: any = await core.account.tesoroAccount.fetch(new PublicKey(opponentAccount));
      const [a, b] = seat === 0 ? [signer.publicKey, opp.authority] : [opp.authority, signer.publicKey];
      await hd.createTable(p, id, a, b, SPEED_TURBO);
      return;
    }

    if (info.owner.equals(HOLDEM_PROGRAM_ID)) {
      const t = decodeTable(ad.gameMatch, hd.program.coder.accounts.decode("gameMatch", info.data));
      if (t.status === STATUS.created) {
        setStage("setup", "Moving the table to the private rollup");
        if (!late) return;
        await hd.delegateTable(p, id);
        return;
      }
      // Committed back after the Match ended: settle.
      delegated.current = false;
      setView((v) => ({ ...v, table: t }));
      setStage("closing", "Settling on Solana devnet");
      if (!closingSince.current) closingSince.current = now();
      const mine = t.status === STATUS.cancelled ? seat === 0 : t.winner === seat;
      if (!mine && now() - closingSince.current < 15_000) return;
      try {
        await hd.finalize(p, id);
      } catch (e) {
        // The other Player may have settled it in the same moment.
        const again = await fetchMatch(id, me);
        if (again && (again.status === "settled" || again.status === "refunded")) return;
        if (++failures.current >= 3) throw e;
      }
      return;
    }

    if (!info.owner.equals(DELEGATION_PROGRAM_ID)) return;
    delegated.current = true;
    const t = await hd.readTable(p, id);
    if (!t) return setStage("setup", "Waiting for the private table");
    applyTable(t);

    if (t.status === STATUS.created) {
      setStage("setup", "Starting the Match");
      if (!late) return;
      try {
        await hd.start(p, id);
      } catch (e) {
        if ((await hd.readTable(p, id))?.status === STATUS.created) throw e;
      }
      return;
    }

    if (t.status === STATUS.live) {
      setStage("live");
      if (t.phase === PHASE.shuffle) await shuffle(t, seat);
      return;
    }

    // Over or cancelled: wipe the hidden accounts and commit everything back.
    setStage("closing", "Committing the table to Solana devnet");
    if (!closingSince.current) closingSince.current = now();
    const mine = t.status === STATUS.cancelled ? seat === 0 : t.winner === seat;
    if (!mine && now() - closingSince.current < 15_000) return;
    if (now() - lastClose.current < 30_000) return;
    lastClose.current = now();
    try {
      await hd.closeMatch(p, id);
    } catch {
      // The other Player closed it first, or the commit is still in flight.
    }

    async function shuffle(tb: Table, s: 0 | 1) {
      if (!p || id === null) return;
      if (contributedHand.current !== tb.handNo) {
        try {
          await hd.contributeEntropy(p, id, false);
        } catch (e) {
          if (!/AlreadyContributed/.test(String(e))) throw e;
        }
        contributedHand.current = tb.handNo;
        contributedAt.current = now();
        lastVrf.current = 0;
        return;
      }
      // Seat 1 asks for the VRF output and deals; seat 0 only steps in if that stalls.
      if (s === 0 && now() - contributedAt.current < 6_000) return;
      if (now() - lastVrf.current > 15_000) {
        try {
          await hd.requestVrf(p, id);
          lastVrf.current = now();
        } catch {
          // Refused until both secrets are in.
        }
      }
      try {
        await hd.deal(p, id);
      } catch {
        // Refused until the VRF output has arrived, or the other Player dealt first.
      }
    }
  }, [p, signer, id, setStage, applyTable, onSettled]);

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
        const hd = getHoldem();
        const t = await hd.readTable(p, id);
        if (!t || stop) return;
        applyTable(t);
        if (t.phase >= PHASE.preflop && t.phase <= PHASE.river && holeHand.current !== t.handNo) {
          const h = await hd.readOwnHole(p, id, seat);
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
  }, [p, id, applyTable]);

  // -- Player decisions -----------------------------------------------------------------------

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      patch({ busy: label, error: null });
      try {
        const sig = await fn();
        // Rollup steps were logged by the client; this catches base-layer ones (refund).
        if (sig) addSig(label, sig, "base");
        if (p && id !== null) {
          const t = await getHoldem().readTable(p, id);
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

  const act = useCallback((a: Action, label: string) => run(label, () => getHoldem().act(p!, id!, a)), [p, id, run]);
  const claimTimeout = useCallback(() => run("claim_timeout", () => getHoldem().claimTimeout(p!, id!)), [p, id, run]);

  return { view, act, claimTimeout, tick, run };
}
