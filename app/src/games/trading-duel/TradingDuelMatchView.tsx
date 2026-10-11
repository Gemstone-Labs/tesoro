"use client";

import { Button, Chip, GemaAmount, Label, Notice } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { matchDelta, matchFee, seatResult } from "@/lib/chain/ledger";
import { refundMatch } from "@/lib/chain/match-flow";
import type { ChainMatch } from "@/lib/chain/read";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult } from "@/components/match/MatchResult";
import { MatchSpectate } from "@/components/match/MatchSpectate";
import { Receipts } from "@/components/match/Receipts";
import { MatchStage, StageAction } from "@/components/match/MatchStage";
import { useGuideHidden } from "@/components/guide/Guide";
import { DRAW, LEAD, STATUS } from "./chain";
import { FillHistory } from "./FillHistory";
import { usePriceFeed } from "./feed";
import { chips, usdMid } from "./fmt";
import { TradingScreen } from "./TradingScreen";
import type { Lead } from "./math";
import { useDuelMatch } from "./useDuelMatch";
import "./trading.css";


function fmtFee(m: ChainMatch): number {
  return matchFee(m);
}

const leadOf = (n: number): Lead => (n === LEAD.seat0 ? "seat0" : n === LEAD.seat1 ? "seat1" : "level");

/**
 * One Trading Duel Match. Waiting for an opponent, the set-up, the trading screen, then the
 * settlement and result with both fill histories. Everything is read from chain, so a reload
 * resumes where you were.
 */
export function TradingDuelMatchView({ matchId }: { matchId: string }) {
  const { auth, refresh, snapshot } = useAccount();
  const signer = auth.signer;
  const id = (() => {
    try {
      return BigInt(matchId);
    } catch {
      return null;
    }
  })();
  const { view, open, close, flip, run } = useDuelMatch(id, signer, refresh);
  const { stage, match: m, duel, book, seat, asset } = view;
  const started = !!duel && duel.status !== STATUS.created && duel.startsAt > 0;
  const showScreen = started && seat !== null && (stage === "live" || stage === "closing");
  const feed = usePriceFeed(asset, showScreen);
  useGuideHidden(showScreen);

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") return <MatchSpectate matchId={matchId} onSignIn={() => auth.openSignIn("Enter a Match")} />;
  if (!signer) return <Notice title="Trading Duel" body="Getting your wallet ready…" />;
  if (stage === "loading") return <Notice title="Trading Duel" body="Loading the Match…" />;
  if (stage === "notfound") return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  if (stage === "spectator") return <MatchSpectate matchId={matchId} />;

  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const delta = m ? matchDelta(m) : 0;
  const refunded = m?.status === "refunded";
  const outcome = !m || stage !== "settled" ? null : refunded ? "refunded" : m.seat !== null && seatResult(m, m.seat) === "won" ? "won" : "lost";

  if (stage === "settled" && m && outcome && seat !== null) {
    const eq = duel?.finalEquity;
    const scores: [string, string] | null = eq && duel && duel.status === STATUS.over ? [`${chips(eq[seat])} Chips`, `${chips(eq[1 - seat])} Chips`] : null;
    return (
      <MatchResult
        game="trading-duel"
        outcome={outcome}
        delta={delta}
        entry={m.entry}
        fee={fmtFee(m)}
        role="player"
        backed={!!m.backing}
        scores={scores}
        scoreNote={duel?.status === STATUS.over ? `${asset.symbol} final price ${usdMid(duel.finalPrice, asset)}${duel.winner === DRAW ? " · equal equity: a draw, both entries refunded" : ""}` : undefined}
        momentKey={m.id.toString()}
        playAgainHref={`/play/queue?game=trading-duel&asset=${asset.symbol.toLowerCase()}&entry=${m.entry}`}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {view.error && <p className="status err" role="alert">{view.error}</p>}
        {duel && view.finalBooks && <FillHistory books={view.finalBooks} duel={duel} mySeat={seat} />}
        <Receipts items={view.sigs} className="td-sigs" />
        <p className="note td-note">Live market prices. Chips only keep score inside the Match. Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchResult>
    );
  }

  const ended = stage === "closing" || (!!duel && duel.status !== STATUS.live);
  const opponent = duel && seat !== null ? { lead: leadOf(duel.lead), trades: duel.trades[1 - seat] } : null;

  const kind = !showScreen && (stage === "waiting" || stage === "setup" || stage === "closing") ? stage : null;
  if (kind && m) {
    return (
      <MatchStage
        game="trading-duel"
        kind={kind}
        entry={m.entry}
        pot={m.entry * 2 - matchFee(m)}
        me={snapshot?.accountKey.toBase58() ?? null}
        opponent={m.opponent}
        asset={asset.symbol}
        step={kind === "setup" ? view.note || "Creating your session" : kind === "closing" ? view.note || "Saving the result" : undefined}
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
      >
        <Receipts items={view.sigs} className="td-sigs" />
        <p className="note td-note">Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchStage>
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
        <TradingScreen
          asset={asset}
          entry={m?.entry}
          feed={feed}
          ledger={book}
          seat={seat}
          opponent={opponent}
          startsAt={duel.startsAt * 1000}
          endsAt={duel.endsAt * 1000}
          ended={ended}
          busy={view.busy}
          error={view.error}
          onOpen={(s, mg, lv) => void open(s, mg, lv)}
          onClose={() => void close()}
          onFlip={(s, mg, lv) => void flip(s, mg, lv)}
          banner={
            stage === "closing" ? (
              <div className="cut cut-frame td-card td-banner" role="status">
                <div>
                  <Label>{duel.status === STATUS.over ? "Match over" : "Closing the Match"}</Label>
                  <p className="meta">
                    {duel.status === STATUS.over
                      ? `Final price ${usdMid(duel.finalPrice, asset)}. ${view.note || "Settling"}…`
                      : `${view.note || "Waiting for the closing price"}…`}
                  </p>
                </div>
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
      <Receipts items={view.sigs} className="td-sigs" />
      <p className="note td-note">Chips only keep score inside the Match. Test mode · Gemas come from simulated yield and have no real value.</p>
    </div>
  );
}

