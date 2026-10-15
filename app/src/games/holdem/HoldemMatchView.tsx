"use client";

import { Busy, Button, Card, Chip, GemaAmount, Label, Notice } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { commitCopy } from "@/lib/chain/commit-pending";
import { matchDelta, matchFee, seatResult } from "@/lib/chain/ledger";
import { refundMatch } from "@/lib/chain/match-flow";
import type { ChainMatch } from "@/lib/chain/read";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult } from "@/components/match/MatchResult";
import { MatchSpectate } from "@/components/match/MatchSpectate";
import { Receipts } from "@/components/match/Receipts";
import { delayedOf } from "@/lib/chain/match-status";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { MatchStage, MatchStageLoading, StageAction } from "@/components/match/MatchStage";
import { STATUS } from "./chain";
import { HoldemTable } from "./HoldemTable";
import { useHoldemMatch } from "./useHoldemMatch";


function fmtFee(m: ChainMatch): string {
  return String(matchFee(m));
}

/**
 * One Hold'em Match. Waiting for an opponent, the table set-up, the table itself, then the
 * settlement and result. Everything is read from chain, so a reload resumes where you were.
 */
export function HoldemMatchView({ matchId }: { matchId: string }) {
  const { auth, refresh, snapshot } = useAccount();
  const signer = auth.signer;
  const nowSecs = useNowSecs();
  const id = (() => {
    try {
      return BigInt(matchId);
    } catch {
      return null;
    }
  })();
  const { view, act, claimTimeout, run } = useHoldemMatch(id, signer, refresh);
  const { stage, match: m, table: t, seat } = view;

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") return <MatchSpectate matchId={matchId} onSignIn={() => auth.openSignIn("Enter a Match")} />;
  if (!signer) return <MatchStageLoading game="holdem" me={snapshot?.accountKey.toBase58() ?? null} step="Getting your wallet ready" />;
  if (stage === "loading") return <MatchStageLoading game="holdem" me={snapshot?.accountKey.toBase58() ?? null} />;
  if (stage === "notfound") return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  if (stage === "spectator") return <MatchSpectate matchId={matchId} />;

  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const delta = m ? matchDelta(m) : 0;
  const refunded = m?.status === "refunded";
  const outcome = !m || stage !== "settled" ? null : refunded ? "refunded" : m.seat !== null && seatResult(m, m.seat) === "won" ? "won" : "lost";
  const tableOver = !!t && t.status !== STATUS.live;
  const refundable = view.refundable;
  const showTable = !!t && seat !== null && (stage === "live" || stage === "closing" || stage === "settled");

  if (stage === "settled" && m && outcome) {
    return (
      <MatchResult
        game="holdem"
        outcome={outcome}
        delta={delta}
        entry={m.entry}
        fee={Number(fmtFee(m))}
        role="player"
        backed={!!m.backing}
        scores={outcome === "refunded" ? null : [outcome === "won" ? "Won" : "Lost", outcome === "won" ? "Lost" : "Won"]}
        momentKey={m.id.toString()}
        playAgainHref={`/play/queue?game=holdem&entry=${m.entry}`}
        opponent={m.opponent}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {view.error && <p className="status err" role="alert">{view.error}</p>}
        <Receipts items={view.sigs} className="hd-sigs" />
        <p className="note hd-note">Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchResult>
    );
  }

  const kind = !showTable && (stage === "waiting" || stage === "setup" || stage === "closing") ? stage : null;
  if (kind && m) {
    return (
      <MatchStage
        game="holdem"
        kind={kind}
        entry={m.entry}
        pot={m.entry * 2 - matchFee(m)}
        me={snapshot?.accountKey.toBase58() ?? null}
        opponent={m.opponent}
        step={kind === "setup" ? view.note || "Creating your session" : kind === "closing" && !view.commit ? view.note || "Saving the result" : undefined}
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
      >
        <Receipts items={view.sigs} className="hd-sigs" />
        <p className="note hd-note">Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchStage>
    );
  }

  return (
    <div className="stack-lg" style={showTable ? undefined : { maxWidth: 480, margin: "0 auto" }}>
      {!showTable && (
        <div className="spread">
          <h1 className="page-title">Hold&apos;em Match</h1>
          {m && (
            <Chip tone="money">
              <GemaAmount value={m.entry} size="sm" /> entry
            </Chip>
          )}
        </div>
      )}

      {showTable && t && seat !== null && (
        <HoldemTable table={t} seat={seat} hole={view.hole} busy={view.busy} ended={tableOver || stage === "settled"} entry={m?.entry} onAct={(a, label) => void act(a, label)} onClaim={() => void claimTimeout()} />
      )}

      {stage === "closing" && (
        <Card large>
          <div className="stack">
            <Label>Match over</Label>
            <Busy>{view.commit ? commitCopy(view.commit).title : `${view.note || "Saving the result"}…`}</Busy>
            <p className="note">{view.commit ? commitCopy(view.commit).line : "Saving the result and paying out the Pot. This takes a few seconds."}</p>
          </div>
        </Card>
      )}


      {m && refundable && stage === "closing" && (
        <Button disabled={view.busy !== null} onClick={() => run("refund", () => refundMatch(signer, m.id))}>
          Refund Match
        </Button>
      )}

      {view.error && <p className="status err" role="alert">{view.error}</p>}

      <Receipts items={view.sigs} className="hd-sigs" />
      <p className="note hd-note">Chips only keep score inside the Match. Test mode · Gemas come from simulated yield and have no real value.</p>
    </div>
  );
}

