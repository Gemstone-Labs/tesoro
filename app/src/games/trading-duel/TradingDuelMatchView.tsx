"use client";

import { parseMatchKey } from "@/lib/chain/match-id";
import { Button, Chip, GemaAmount, Notice } from "@/components/ui";
import { usePlayerLabel } from "@/components/account/Player";
import { shownIdentity } from "@/lib/identity/display";
import { useAccount } from "@/lib/account";
import { matchDelta, matchFee, seatResult } from "@/lib/chain/ledger";
import { refundMatch } from "@/lib/chain/match-flow";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult } from "@/components/match/MatchResult";
import { MatchSpectate } from "@/components/match/MatchSpectate";
import { CANCELLING_NOTE, delayedOf } from "@/lib/chain/match-status";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { MatchStage, MatchStageLoading, StageAction } from "@/components/match/MatchStage";
import { useGuideHidden } from "@/components/guide/Guide";
import { STATUS } from "./chain";
import { usePriceFeed } from "./feed";
import { usdMid } from "./fmt";
import { GridScreen, type GridSide } from "./GridScreen";
import { gridInputs, isDraw } from "./matchView";
import { useDuelMatch } from "./useDuelMatch";
import "./trading.css";

/** Name and animal for one side of the screen. */
function useSide(account: string | null | undefined, fallback: string): GridSide {
  const name = usePlayerLabel(account);
  return { name: name || fallback, avatar: account ? shownIdentity(account).avatar : undefined };
}

/**
 * One Trading Duel Match. Waiting for an opponent, the set-up, the grid screen (the same one as
 * practice, fed from chain), then the settlement and result. Everything is read from chain, so a
 * reload resumes where you were.
 */
export function TradingDuelMatchView({ matchId }: { matchId: string }) {
  const { auth, refresh, snapshot } = useAccount();
  const signer = auth.signer;
  const nowSecs = useNowSecs();
  const id = parseMatchKey(matchId) ? matchId : null;
  const { view, pick, run } = useDuelMatch(id, signer, refresh);
  const { stage, match: m, duel, book, seat, asset } = view;
  const started = !!duel && duel.status !== STATUS.created && duel.startsAt > 0;
  const showScreen = started && seat !== null && (stage === "live" || stage === "closing");
  const feed = usePriceFeed(asset, showScreen);
  useGuideHidden(showScreen);
  const meKey = snapshot?.accountKey.toBase58() ?? null;
  const meSide = useSide(meKey, "You");
  const foeSide = useSide(m?.opponent, "Opponent");

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") return <MatchSpectate matchId={matchId} onSignIn={() => auth.openSignIn("Enter a Match")} />;
  if (!signer) return <MatchStageLoading game="trading-duel" me={snapshot?.accountKey.toBase58() ?? null} step="Getting your wallet ready" />;
  if (stage === "loading") return <MatchStageLoading game="trading-duel" me={snapshot?.accountKey.toBase58() ?? null} />;
  if (stage === "notfound") return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  if (stage === "spectator") return <MatchSpectate matchId={matchId} />;

  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const delta = m ? matchDelta(m) : 0;
  const refunded = m?.status === "refunded";
  const outcome = !m || stage !== "settled" ? null : refunded ? "refunded" : m.seat !== null && seatResult(m, m.seat) === "won" ? "won" : "lost";

  if (stage === "settled" && m && outcome && seat !== null) {
    const scores: [string, string] | null = duel && duel.status === STATUS.over ? [`${duel.scores[seat]} points`, `${duel.scores[1 - seat]} points`] : null;
    return (
      <MatchResult
        game="trading-duel"
        outcome={outcome}
        delta={delta}
        entry={m.entry}
        fee={matchFee(m)}
        role="player"
        backed={!!m.backing}
        scores={scores}
        scoreNote={duel?.status === STATUS.over ? `${asset.symbol} ended at ${usdMid(duel.track.last ?? duel.anchor, asset)}${isDraw(duel) ? " · equal points: a draw, both entries refunded" : ""}` : undefined}
        momentKey={m.id.toString()}
        matchId={m.id.toString()}
        playAgainHref={`/play/queue?game=trading-duel&asset=${asset.symbol.toLowerCase()}&entry=${m.entry}`}
        opponent={m.opponent}
        points={m.settled?.points}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {view.error && <p className="status err" role="alert">{view.error}</p>}
        <p className="note td-note">Live market prices.</p>
      </MatchResult>
    );
  }

  const kind = !showScreen && (stage === "waiting" || stage === "setup" || stage === "closing") ? stage : null;
  const cancelSent = view.busy === "refund" && stage === "waiting";
  if (kind && m) {
    return (
      <MatchStage
        game="trading-duel"
        matchId={matchId}
        kind={cancelSent ? "setup" : kind}
        entry={m.entry}
        pot={m.entry * 2 - matchFee(m)}
        me={snapshot?.accountKey.toBase58() ?? null}
        opponent={m.opponent}
        asset={asset.symbol}
        step={cancelSent ? CANCELLING_NOTE : kind === "setup" ? view.note || "Creating your session" : kind === "closing" && !view.commit ? view.note || "Saving the result" : undefined}
        commit={kind === "closing" ? view.commit : null}
        delayed={kind === "closing" ? delayedOf(m, nowSecs) : null}
        deadline={m.deadline || undefined}
        challengeLink={m.challenge && kind === "waiting" ? link : null}
        backedShareBps={m.backing && m.seat !== null ? m.backing.shareBps : null}
        error={view.error}
        actions={
          (kind === "waiting" || view.refundable) && (
            <StageAction disabled={view.busy !== null} onClick={() => void run("refund", () => refundMatch(signer, m.id))}>
              {view.busy === "refund" ? "Refunding…" : kind === "waiting" ? "Cancel and refund" : "Refund Match"}
            </StageAction>
          )
        }
      />
    );
  }

  return (
    <div className="stack-lg" style={showScreen ? undefined : { maxWidth: 480, margin: "0 auto" }}>
      {!showScreen && (
        <div className="spread">
          <h1 className="page-title">Trading Duel</h1>
          {m && (
            <Chip tone="money">
              <GemaAmount value={m.entry} size="sm" /> entry
            </Chip>
          )}
        </div>
      )}

      {showScreen && seat !== null && duel && (
        <GridScreen
          asset={asset.symbol}
          anchor={duel.anchor}
          step={duel.step}
          startsAt={duel.startsAt * 1000}
          track={duel.track}
          series={feed.series}
          stale={feed.status === "stale"}
          {...gridInputs(duel, seat, book, view.pending)}
          me={meSide}
          opponent={foeSide}
          entry={m?.entry}
          pot={m ? m.entry * 2 - matchFee(m) : undefined}
          error={view.error}
          clockOffsetMs={view.clockOffsetMs}
          payingOut={stage === "closing" && duel.status === STATUS.over}
          onPick={pick}
          exitHref="/play"
          banner={
            stage === "closing" ? (
              <div className="cut cut-frame td-card td-banner" role="status">
                <p className="meta">{duel.status === STATUS.over ? `Match over. ${view.note || "Settling"}…` : `${view.note || "Waiting for the closing price"}…`}</p>
              </div>
            ) : undefined
          }
        />
      )}

      {m && view.refundable && stage === "closing" && (
        <Button disabled={view.busy !== null} onClick={() => void run("refund", () => refundMatch(signer, m.id))}>
          Refund Match
        </Button>
      )}

      {view.error && !showScreen && <p className="status err" role="alert">{view.error}</p>}
    </div>
  );
}

