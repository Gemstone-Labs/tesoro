"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/ui";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { ELSEWHERE_LINE, QUEUE_SIT_LINE, QUEUE_STAY_LINE, needTableLine, resultLine } from "@/games/block-puzzle/burst-copy";
import { CHECKIN_SECS } from "@/games/block-puzzle/live-chain";
import { getReadySecs, slotNow } from "@/games/block-puzzle/live-clock";
import { stripOf } from "@/games/block-puzzle/opponent";
import { useBurstMatch } from "@/games/block-puzzle/useBurstMatch";
import { useAccount } from "@/lib/account";
import { backerDelta, matchDelta, matchFee, seatResult } from "@/lib/chain/ledger";
import { parseMatchKey } from "@/lib/chain/match-id";
import { refundMatch } from "@/lib/chain/match-flow";
import { delayedOf, refundByText } from "@/lib/chain/match-status";
import { useQueuePresence } from "@/lib/chain/usePresence";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { plainError } from "@/lib/errors";
import { BackingSplit } from "./BackingSplit";
import { BurstOpponentStrip } from "./BurstOpponentStrip";
import { MatchResult } from "./MatchResult";
import { MatchSpectate } from "./MatchSpectate";
import { MatchStage, MatchStageLoading, StageAction, type StageKind } from "./MatchStage";
import { Receipts } from "./Receipts";

/** Re-renders every `ms`, so the get-ready count and the check-in clock follow the rollup's slot clock. */
function useTicker(ms: number, on: boolean): number {
  const [t, setT] = useState(() => (typeof performance === "undefined" ? 0 : performance.now()));
  useEffect(() => {
    if (!on) return;
    const i = setInterval(() => setT(performance.now()), ms);
    return () => clearInterval(i);
  }, [ms, on]);
  return t;
}

/**
 * One Block Burst Match, driven by the table it runs on: waiting for an opponent, waiting for a table, check-in, the
 * Seed, the get-ready count, the 90 s run (both Players at once, the timer from the table's start slot), then the result.
 * Every step re-reads the chain, so a reload resumes where you were.
 */
export function MatchView({ matchId }: { matchId: string }) {
  const { auth, refresh, snapshot } = useAccount();
  const signer = auth.signer;
  const nowSecs = useNowSecs();
  const id = parseMatchKey(matchId) ? matchId : null;
  const me = snapshot?.accountKey.toBase58() ?? null;
  const { view } = useBurstMatch(id, signer, me, refresh);
  const { stage, match: m, seat, table, clock, assignment } = view;
  const [busy, setBusy] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundSig, setRefundSig] = useState<{ label: string; sig: string; layer: "base" | "tee" }[]>([]);
  const perf = useTicker(250, stage === "setup" || stage === "getReady" || stage === "playing" || stage === "closing");

  // The Queue lease: while you sit alone in the Queue the page tells the Queue it is here.
  useQueuePresence(m?.id ?? null, !!m && m.status === "open" && !m.challenge && m.seat === 0);

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") return <MatchSpectate matchId={matchId} onSignIn={() => auth.openSignIn("Enter a Match")} />;
  if (!signer) return <MatchStageLoading game="block-puzzle" me={me} step="Getting your wallet ready" />;
  if (stage === "loading") return <MatchStageLoading game="block-puzzle" me={me} />;
  if (stage === "notfound") return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  if (stage === "spectator") return <MatchSpectate matchId={matchId} />;

  const slot = clock ? slotNow(clock, perf) : 0;
  const strip = stripOf({ table, assigned: !!assignment, slot, seat: seat ?? 0, ownOver: view.ownOver });
  const sigs = [...view.sigs, ...refundSig];

  if (view.run && (stage === "playing" || stage === "closing") && m) {
    return (
      <div className="stack">
        <BlockPuzzleGame
          run={view.run}
          matchPanel={
            <div className="bpx-status">
              <BurstOpponentStrip account={m.opponent} state={strip} />
              {view.reconnecting && <p className="note">Reconnecting…</p>}
              {view.error && <p className="status err" role="alert">{view.error}</p>}
            </div>
          }
        />
      </div>
    );
  }

  const asBacker = !!m && m.seat === null && m.backerSeat !== null;
  const playerBacked = !!m && m.seat !== null && m.backing !== null;
  const mineIdx = (m?.seat ?? m?.backerSeat ?? 0) as 0 | 1;
  const result = view.result ?? m?.session ?? null;

  if (stage === "settled" && m) {
    const draw = result?.result === "draw";
    const known = result ? (draw ? "draw" : seatResult({ session: result }, mineIdx)) : null;
    const delta = asBacker && m.backing ? backerDelta({ ...m, backerSeat: m.backing.seat, shareBps: m.backing.shareBps }) : matchDelta(m);
    const outcome = m.status === "refunded" ? "refunded" : (known ?? (delta > 0 ? "won" : delta < 0 ? "lost" : "draw"));
    const scores = result && outcome !== "refunded" ? ([String(result.scores[mineIdx]), String(result.scores[1 - mineIdx])] as [string, string]) : null;
    const why = resultLine(view.reason, outcome);
    return (
      <MatchResult
        game="block-puzzle"
        outcome={outcome}
        delta={delta}
        entry={m.entry}
        fee={matchFee(m)}
        role={asBacker ? "backer" : "player"}
        backed={!!m.backing}
        scores={scores}
        momentKey={m.id.toString()}
        matchId={m.id.toString()}
        playAgainHref={`/play/queue?entry=${m.entry}`}
        opponent={m.opponent}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {why && <p className="note">{why}</p>}
        {view.error && <p className="status err" role="alert">{view.error}</p>}
        <Receipts items={sigs} />
        <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchResult>
    );
  }
  if (!m) return <MatchStageLoading game="block-puzzle" me={me} />;

  const refund = async () => {
    setBusy("refund");
    setRefundError(null);
    try {
      const sig = await refundMatch(signer, m.id, auth.getAccessToken);
      setRefundSig((s) => [...s, { label: "refund", sig, layer: "base" }]);
    } catch (e) {
      setRefundError(plainError(e));
    } finally {
      setBusy(null);
    }
  };

  const link = typeof window === "undefined" ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const refundBy = refundByText(m.deadline, nowSecs * 1000);
  const checkInLeft = table && clock ? Math.max(0, Math.ceil(CHECKIN_SECS - (slot - table.assignedSlot) / 100)) : null;
  const readyIn = table && clock ? getReadySecs(table, clock, perf) : null;

  let kind: StageKind;
  let words: { kicker?: string; title?: string; line?: string } | undefined;
  let step: string | undefined;
  if (stage === "backer") kind = "backer-watch";
  else if (stage === "waiting") {
    kind = "waiting";
    words = m.challenge ? undefined : { line: `${QUEUE_SIT_LINE} ${QUEUE_STAY_LINE}` };
  } else if (stage === "table") {
    kind = "setup";
    words = { kicker: "Block Burst · opponent found", title: "Waiting for a table", line: needTableLine(refundBy) };
  } else if (stage === "getReady") {
    kind = "setup";
    words = { title: readyIn === null ? "Get ready" : `Starting in ${readyIn}`, line: "Same pieces for you both, at the same time. Your 90 seconds start on zero." };
  } else if (view.elsewhere) {
    kind = "awaiting";
    words = { title: "Playing in another tab", line: ELSEWHERE_LINE };
  } else if (stage === "closing") {
    kind = "closing";
  } else {
    kind = "setup";
    const t = table;
    if (t && t.seatsOpen && !t.checkedIn[seat ?? 0] && t.phase === 1) step = "Checking you in";
    words = {
      title: t && t.phase === 2 ? "Dealing your pieces" : "Get ready",
      line:
        t && t.phase === 1 && t.checkedIn[seat ?? 0] && checkInLeft !== null
          ? `You’re in. Waiting for your opponent to check in (${checkInLeft} s). If they don’t, you win.`
          : "Your pieces are drawn in secret.",
    };
  }

  return (
    <MatchStage
      game="block-puzzle"
      kind={kind}
      entry={m.entry}
      pot={m.entry * 2 - matchFee(m)}
      me={asBacker ? (m.backing?.player ?? null) : me}
      opponent={m.opponent}
      step={step}
      deadline={kind === "waiting" ? m.deadline || undefined : undefined}
      challengeLink={m.challenge && kind === "waiting" ? link : null}
      backedShareBps={playerBacked && m.backing ? m.backing.shareBps : null}
      commit={view.commit}
      delayed={delayedOf(m, nowSecs)}
      error={refundError ?? view.error}
      words={words}
      actions={
        <>
          {kind === "waiting" && (
            <StageAction disabled={busy !== null} onClick={() => void refund()}>
              {busy === "refund" ? "Refunding…" : playerBacked ? "Cancel (Gemas return to your Backer)" : "Cancel and refund"}
            </StageAction>
          )}
          {view.refundable && kind !== "waiting" && (
            <StageAction disabled={busy !== null} onClick={() => void refund()}>
              Refund Match
            </StageAction>
          )}
        </>
      }
    >
      <Receipts items={sigs} />
      <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
    </MatchStage>
  );
}
