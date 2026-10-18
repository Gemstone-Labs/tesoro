"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain, getVanguard } from "@/lib/chain/client";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { commitPhase, isCommitPending, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { plainError } from "@/lib/errors";
import { PublicKey } from "@solana/web3.js";
import { VANGUARD_PROGRAM_ID, addresses, type PlayerSigner } from "./chain";
import { claimDue, turnKey } from "./clock";
import { STATUS, battleKey, decodeBattle, type ArmyAccount, type Battle } from "./decode";

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
  /** When this client first saw the current turn (ms): the 5 second countdown runs from here. */
  turnSeenAt: number;
  note: string;
  error: string | null;
  sigs: { label: string; sig: string; layer: "base" | "tee" }[];
  busy: string | null;
  /** The tesoro_core refund deadline passed on an unfinished Match. */
  refundable: boolean;
  commit: CommitState | null;
}

/** How long the Player who does not settle at once waits before settling a still-open Match. */
const FINALIZE_GRACE_MS = 20_000;
/** The opener steps in for the joiner's set-up steps after this long. */
const OPENER_LATE_MS = 12_000;
const now = () => Date.now();

/**
 * Drives one Vanguard Match for one Player: reads the Battle and your own Army from the private rollup and does
 * every step that is not a move (create and delegate the Battle, permissions, entropy and the deal, close and
 * settle, and a timeout claim once a deadline has passed). Both Players' clients run the same driver; a step
 * that either may do is tried by one client first and by the other after a grace period, and a lost race is
 * harmless because each step re-reads chain state.
 */
export function useVanguardMatch(id: bigint | null, signer: ChainSigner | null, onSettled?: () => void) {
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
  const lastClaim = useRef(0);
  const settledSeen = useRef(false);
  const finalRead = useRef(false);
  const delegated = useRef(false);
  const failures = useRef(0);
  const turnSeenRef = useRef(0);

  useEffect(() => {
    turnSeenRef.current = view.turnSeenAt;
  }, [view.turnSeenAt]);
  const p = useMemo(() => (signer ? (signer as unknown as PlayerSigner) : null), [signer]);

  const setStage = useCallback((s: Stage, note = "") => {
    stage.current = s;
    setView((v) => (v.stage === s && v.note === note ? v : { ...v, stage: s, note }));
  }, []);

  const addSig = useCallback((label: string, sig: string | undefined, layer: "base" | "tee") => {
    if (sig) setView((v) => (v.sigs.some((x) => x.sig === sig) ? v : { ...v, sigs: [...v.sigs, { label, sig, layer }] }));
  }, []);

  const applyBattle = useCallback((b: Battle) => {
    const k = battleKey(b);
    if (k === shownKey.current) return;
    shownKey.current = k;
    const tk = turnKey(b);
    const fresh = tk !== turnId.current;
    turnId.current = tk;
    setView((v) => ({ ...v, battle: b, turnSeenAt: fresh ? now() : v.turnSeenAt }));
  }, []);

  useEffect(() => {
    const vg = getVanguard();
    vg.onTx = (label, layer, sig) => addSig(label, sig, layer);
    return () => {
      vg.onTx = undefined;
    };
  }, [addSig]);

  // -- the driver (sequential; one step per tick) --------------------------------------------

  const step = useCallback(async () => {
    if (!p || !signer || id === null) return;
    const vg = getVanguard();
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
        const b = await vg.readBattleOnBase(id);
        if (b) setView((v) => ({ ...v, battle: b }));
      }
      if (!settledSeen.current) {
        settledSeen.current = true;
        setCommitPending(id, false);
        onSettled?.();
      }
      return;
    }

    // Active: the Battle has to exist, live on the rollup, and be set up.
    if (!activeSince.current) activeSince.current = now();
    // The joiner sets the Battle up; the opener steps in if that stalls.
    const late = now() - activeSince.current >= (seat === 1 ? 0 : OPENER_LATE_MS);
    const info = await vg.base.getAccountInfo(ad.battle);

    if (!info) {
      setStage("setup", "Setting up the Match");
      if (!late || !m.opponent) return;
      const core = getChain().core;
      const opp: any = await core.account.tesoroAccount.fetch(new PublicKey(m.opponent));
      const [a, b] = seat === 0 ? [signer.publicKey, opp.authority] : [opp.authority, signer.publicKey];
      await vg.createMatch(p, id, a, b);
      return;
    }

    if (info.owner.equals(VANGUARD_PROGRAM_ID)) {
      const b = decodeBattle(info.data);
      if (b.status === STATUS.created) {
        setStage("setup", "Creating your session");
        if (!late) return;
        await vg.delegateMatch(p, id);
        return;
      }
      // Committed back after the Match ended: settle.
      delegated.current = false;
      setView((v) => ({ ...v, battle: b }));
      setStage("closing", "Paying out the Pot");
      setView((v) => (v.commit ? { ...v, commit: null } : v));
      if (!closingSince.current) closingSince.current = now();
      // One Player settles at once (the winner; seat 0 for a draw or a cancel). The other waits and settles
      // only if the Match is still open then, so the loser of a race does not burn a fee.
      const mine = b.winner === 0 || b.winner === 1 ? b.winner === seat : seat === 0;
      if (!mine && now() - closingSince.current < FINALIZE_GRACE_MS) return;
      try {
        await vg.finalize(p, id);
      } catch (e) {
        const again = await fetchMatch(id, me);
        if (again && (again.status === "settled" || again.status === "refunded")) return;
        if (++failures.current >= 3) throw e;
      }
      return;
    }

    if (!info.owner.equals(DELEGATION_PROGRAM_ID)) return;
    delegated.current = true;
    const b = await vg.readBattle(p, id);
    if (!b) return setStage("setup", "Creating your session");
    applyBattle(b);

    if (b.status === STATUS.created) {
      setStage("setup", "Setting up the Match");
      if (!late) return;
      try {
        await vg.initPermissions(p, id);
      } catch (e) {
        if ((await vg.readBattle(p, id))?.status === STATUS.created) throw e;
      }
      return;
    }

    if (b.status === STATUS.setup) {
      setStage("setup", "Drawing the armies in secret");
      await setUp(seat);
      return;
    }

    if (b.status === STATUS.live) {
      setStage("live");
      return;
    }

    // Over or cancelled: wipe the private accounts and commit everything back.
    setStage("closing", "Saving the result");
    if (!closingSince.current) closingSince.current = now();
    const mine = b.winner === 0 || b.winner === 1 ? b.winner === seat : seat === 0;
    if (!mine && now() - closingSince.current < 15_000) return;
    if (commitSince.current) {
      const phase = commitPhase(commitSince.current, now());
      setView((v) => (v.commit?.phase === phase && v.commit.won === mine ? v : { ...v, commit: { phase, won: mine }, error: null }));
      return;
    }
    if (now() - lastClose.current < 30_000) return;
    lastClose.current = now();
    try {
      if (b.permissioned) await vg.closeMatch(p, id);
      else await vg.closeUnstarted(p, id);
    } catch (e) {
      // The other Player closed it first, or the commit is already in flight: only other errors count.
      if (!isCommitPending(e) && ++closeFailures.current >= 3) throw e;
      if (!isCommitPending(e)) return;
    }
    commitSince.current = now();
    setCommitPending(id, true);
    setView((v) => ({ ...v, commit: { phase: "sending", won: mine } }));

    async function setUp(s: 0 | 1) {
      if (!p || id === null) return;
      if (!contributed.current) {
        try {
          await vg.contributeEntropy(p, id, false);
        } catch (e) {
          if (!/AlreadyContributed/.test(String(e))) throw e;
        }
        contributed.current = true;
        contributedAt.current = now();
        lastVrf.current = 0;
        return;
      }
      // Seat 1 asks for the randomness and deals; seat 0 only steps in if that stalls.
      if (s === 0 && now() - contributedAt.current < 6_000) return;
      if (now() - lastVrf.current > 15_000) {
        try {
          await vg.requestVrf(p, id);
          lastVrf.current = now();
        } catch {
          // Refused until both secrets are in.
        }
      }
      try {
        await vg.deal(p, id);
      } catch {
        // Refused until the randomness has arrived, or the other Player dealt first.
      }
    }
  }, [p, signer, id, setStage, applyBattle, onSettled]);

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
    let unwatch: (() => void) | null = null;
    void getVanguard()
      .watchBattle(p, id, (b) => {
        if (!stop) applyBattle(b);
      })
      .then((u) => {
        if (stop) u();
        else unwatch = u;
      })
      .catch(() => undefined);
    const poll = async () => {
      const seat = seatRef.current;
      if (busy || stop || seat === null || !delegated.current || !["live", "closing", "setup"].includes(stage.current)) return;
      busy = true;
      try {
        const vg = getVanguard();
        const b = await vg.readBattle(p, id);
        if (!b || stop) return;
        applyBattle(b);
        if (b.status >= STATUS.setup) {
          const army = await vg.readOwnArmy(p, id, seat);
          if (army && army.ranks.some((r) => r !== 0) && !stop) setView((v) => (v.army && v.army.moves === army.moves && v.army.fuel === army.fuel && v.army.side === army.side ? v : { ...v, army }));
        }
        // Past a deadline the program passes the turn, ends the Match on the cap or cancels it; anyone may ask.
        const seenAt = turnSeenRef.current || now();
        if ((b.status === STATUS.live || b.status === STATUS.setup) && claimDue(b, seenAt, now()) && now() - lastClaim.current > 2_500) {
          lastClaim.current = now();
          await vg.claimTimeout(p, id).catch(() => undefined);
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
      unwatch?.();
      clearInterval(t);
    };
  }, [p, id, applyBattle]);

  // -- Player decisions -----------------------------------------------------------------------

  /** Send a move. Resolves when the rollup confirmed it, rejects (with a plain message) when it did not. */
  const move = useCallback(
    async (piece: number, to: number) => {
      if (!p || id === null) throw new Error("Not ready");
      try {
        await getVanguard().movePiece(p, id, piece, to);
      } catch (e) {
        throw new Error(plainError(e));
      }
    },
    [p, id],
  );

  const twoStep = useCallback(async () => {
    if (!p || id === null) throw new Error("Not ready");
    try {
      await getVanguard().startTwoStep(p, id);
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

  return { view, move, twoStep, tick, run };
}
