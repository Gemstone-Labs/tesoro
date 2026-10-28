"use client";

import { parseMatchKey } from "@/lib/chain/match-id";
import { Busy, Button, Card, Label, Notice } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { commitCopy } from "@/lib/chain/commit-pending";
import { matchDelta, matchFee, resultFee, seatResult } from "@/lib/chain/ledger";
import { refundMatch } from "@/lib/chain/match-flow";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult } from "@/components/match/MatchResult";
import { MatchSpectate } from "@/components/match/MatchSpectate";
import { CANCELLING_NOTE, delayedOf } from "@/lib/chain/match-status";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { MatchStage, MatchStageLoading, StageAction, delayedCopy } from "@/components/match/MatchStage";
import { STATUS } from "./decode";
import { EndWhy } from "./EndWhy";
import { VanguardTable } from "./VanguardTable";
import { useVanguardMatch } from "./useVanguardMatch";

/**
 * One Vanguard Match. Waiting for an opponent, the set-up, the table itself, then the settlement and result.
 * Everything is read from chain, so a reload resumes where you were.
 */
export function VanguardMatchView({ matchId }: { matchId: string }) {
  const { auth, refresh, snapshot } = useAccount();
  const signer = auth.signer;
  const nowSecs = useNowSecs();
  const id = parseMatchKey(matchId) ? matchId : null;
  const { view, move, power, twoStep, run } = useVanguardMatch(id, signer, refresh);
  const { stage, match: m, battle, army, seat } = view;
  const me = snapshot?.accountKey.toBase58() ?? null;

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") return <MatchSpectate matchId={matchId} onSignIn={() => auth.openSignIn("Enter a Match")} />;
  if (!signer) return <MatchStageLoading game="vanguard" me={me} step="Getting your wallet ready" />;
  if (stage === "loading") return <MatchStageLoading game="vanguard" me={me} />;
  if (stage === "notfound") return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  if (stage === "spectator") return <MatchSpectate matchId={matchId} />;

  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const refunded = m?.status === "refunded";
  const outcome = !m || stage !== "settled" ? null : refunded ? "refunded" : m.seat !== null && seatResult(m, m.seat) === "won" ? "won" : "lost";
  const showTable = !!battle && !!army && seat !== null && (stage === "live" || stage === "closing") && battle.status >= STATUS.live;

  if (stage === "settled" && m && outcome) {
    return (
      <MatchResult
        game="vanguard"
        outcome={outcome}
        delta={matchDelta(m)}
        entry={m.entry}
        fee={resultFee(m, outcome)}
        role="player"
        backed={!!m.backing}
        scores={null}
        momentKey={m.id.toString()}
        matchId={m.id.toString()}
        playAgainHref={`/play/queue?game=vanguard&entry=${m.entry}`}
        opponent={m.opponent}
        points={m.settled?.points}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {battle && seat !== null && <EndWhy battle={battle} seat={seat} />}
        {view.error && <p className="status err" role="alert">{view.error}</p>}
      </MatchResult>
    );
  }

  const late = m && (stage === "live" || stage === "setup") ? delayedOf(m, nowSecs) : null;
  const kind = !showTable && (stage === "waiting" || stage === "setup" || stage === "closing" || stage === "live") ? (stage === "live" ? "setup" : stage) : null;
  const cancelSent = view.busy === "refund" && stage === "waiting";
  if (kind && m) {
    return (
      <MatchStage
        game="vanguard"
        matchId={matchId}
        kind={cancelSent ? "setup" : kind}
        entry={m.entry}
        pot={m.entry * 2 - matchFee(m)}
        me={me}
        opponent={m.opponent}
        step={cancelSent ? CANCELLING_NOTE : kind === "setup" ? view.note || "Getting your army" : kind === "closing" && !view.commit ? view.note || "Saving the result" : undefined}
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
        {late && <Notice title={delayedCopy(late).title} body={delayedCopy(late).line} />}
      </MatchStage>
    );
  }

  const over = !!battle && battle.status > STATUS.live;
  return (
    <div className="stack-lg">
      {late && <Notice title={delayedCopy(late).title} body={delayedCopy(late).line} />}
      {showTable && battle && army && seat !== null && (
        <VanguardTable battle={battle} army={army} seat={seat} turnSeenAt={view.turnSeenAt} onMove={move} onPower={power} onTwoStep={twoStep} ended={over || stage === "closing"} reconnecting={view.reconnecting}>
          {stage === "closing" && (
            <Card large>
              <div className="stack">
                <Label>Match over</Label>
                {battle && seat !== null && <EndWhy battle={battle} seat={seat} titleOnly />}
                <Busy>{view.commit ? commitCopy(view.commit).title : `${view.note || "Saving the result"}…`}</Busy>
                <p className="note">{view.commit ? commitCopy(view.commit).line : "Saving the result and paying out the Pot. This takes a few seconds."}</p>
              </div>
            </Card>
          )}
          {m && view.refundable && stage === "closing" && (
            <Button disabled={view.busy !== null} onClick={() => run("refund", () => refundMatch(signer, m.id))}>
              Refund Match
            </Button>
          )}
          {view.error && <p className="status err" role="alert">{view.error}</p>}
        </VanguardTable>
      )}
    </div>
  );
}
