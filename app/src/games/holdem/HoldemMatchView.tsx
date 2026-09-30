"use client";

import { useState } from "react";
import { Button, Card, Chip, GemaAmount, Label } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { matchDelta } from "@/lib/chain/ledger";
import { refundMatch } from "@/lib/chain/match-flow";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult } from "@/components/match/MatchResult";
import { STATUS } from "./chain";
import { HoldemTable } from "./HoldemTable";
import { useHoldemMatch } from "./useHoldemMatch";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function fmtFee(m: ChainMatch): string {
  const pot = m.entry * 2;
  return String(Math.floor((pot * m.fees.platformBps) / 10_000) + Math.floor((pot * m.fees.studioBps) / 10_000));
}

/**
 * One Hold'em Match. Waiting for an opponent, the table set-up, the table itself, then the
 * settlement and result. Everything is read from chain, so a reload resumes where you were.
 */
export function HoldemMatchView({ matchId }: { matchId: string }) {
  const { auth, refresh } = useAccount();
  const signer = auth.signer;
  const id = (() => {
    try {
      return BigInt(matchId);
    } catch {
      return null;
    }
  })();
  const { view, act, claimTimeout, run } = useHoldemMatch(id, signer, refresh);
  const [copied, setCopied] = useState(false);
  const { stage, match: m, table: t, seat } = view;

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see this Match">
        <div className="stack">
          <h1 className="page-title">Hold&apos;em</h1>
          <p className="meta">Sign in to play this Match.</p>
          <Button block onClick={() => auth.openSignIn("Enter a Match")}>Sign in</Button>
        </div>
      </Card>
    );
  }
  if (!signer) return <Notice title="Hold'em" body="Getting your wallet ready…" />;
  if (stage === "loading") return <Notice title="Hold'em" body="Reading the Match from Solana devnet…" />;
  if (stage === "notfound") return <Notice title="Match not found" body="No Match with that id on devnet." />;
  if (stage === "spectator") return <Notice title="Not your Match" body="You are not one of the two Players of this Match." />;

  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const delta = m ? matchDelta(m) : 0;
  const refunded = m?.status === "refunded";
  const outcome = !m || stage !== "settled" ? null : refunded ? "refunded" : delta > 0 ? "won" : "lost";
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
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {view.error && <p className="status err" role="alert">{view.error}</p>}
        {view.sigs.length > 0 && (
          <details className="stack hd-sigs">
            <summary className="label">Transactions ({view.sigs.length})</summary>
            {view.sigs.map((s) =>
              s.layer === "base" ? (
                <a key={s.sig} className="meta mono" href={explorer(s.sig)} target="_blank" rel="noreferrer">
                  {s.label} · {s.sig.slice(0, 10)}…
                </a>
              ) : (
                <span key={s.sig} className="meta mono" title={`${s.sig} (private rollup, no public explorer page)`}>
                  {s.label} · {s.sig.slice(0, 10)}… (TEE)
                </span>
              ),
            )}
          </details>
        )}
        <p className="note">Solana devnet + MagicBlock private rollup · testnet Gemas from a simulated Position.</p>
      </MatchResult>
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

      {stage === "waiting" && m && (
        <Card large>
          <div className="stack">
            <Label>Waiting for an opponent</Label>
            <p className="meta">
              Your entry of {fmtGemas(m.entry)} Gemas is held in escrow. Both Players must be at the table: the hand is dealt the moment
              an opponent joins. Keep this page open, or come back from the Lobby.
            </p>
            {m.challenge && (
              <div className="stack">
                <Label>Challenge link</Label>
                <code className="mono" style={{ wordBreak: "break-all", fontSize: 12 }}>{link}</code>
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <p className="note">Whoever opens this link joins with the same entry. Send it to the person you want to play.</p>
              </div>
            )}
            <Button
              disabled={view.busy !== null}
              onClick={() => run("refund", () => refundMatch(signer, m.id))}
            >
              {view.busy === "refund" ? "Refunding…" : "Cancel and refund entry"}
            </Button>
          </div>
        </Card>
      )}

      {stage === "setup" && (
        <Card large>
          <div className="stack">
            <Label>Opponent found · getting the table ready</Label>
            <p className="status" role="status">{view.note || "Preparing"}…</p>
            <p className="note">
              The table and the shuffled deck move to a private rollup, so neither Player can see the other&apos;s cards. Turbo blinds
              (50/100, rising every hand). About 30 seconds.
            </p>
          </div>
        </Card>
      )}

      {showTable && t && seat !== null && (
        <HoldemTable table={t} seat={seat} hole={view.hole} busy={view.busy} ended={tableOver || stage === "settled"} entry={m?.entry} onAct={(a, label) => void act(a, label)} onClaim={() => void claimTimeout()} />
      )}

      {stage === "closing" && (
        <Card large>
          <div className="stack">
            <Label>Match over · settling</Label>
            <p className="status" role="status">{view.note}…</p>
            <p className="note">The table is wiped of hidden cards, committed back to Solana, then the Pot is settled once.</p>
          </div>
        </Card>
      )}


      {m && refundable && (stage === "setup" || stage === "closing") && (
        <Button disabled={view.busy !== null} onClick={() => run("refund", () => refundMatch(signer, m.id))}>
          Refund Match
        </Button>
      )}

      {view.error && <p className="status err" role="alert">{view.error}</p>}

      {view.sigs.length > 0 && (
        <details className="stack hd-sigs">
          <summary className="label">Transactions ({view.sigs.length})</summary>
          {view.sigs.map((s) =>
            s.layer === "base" ? (
              <a key={s.sig} className="meta mono" href={explorer(s.sig)} target="_blank" rel="noreferrer">
                {s.label} · {s.sig.slice(0, 10)}…
              </a>
            ) : (
              <span key={s.sig} className="meta mono" title={`${s.sig} (private rollup, no public explorer page)`}>
                {s.label} · {s.sig.slice(0, 10)}… (TEE)
              </span>
            ),
          )}
        </details>
      )}
      <p className="note">Solana devnet + MagicBlock private rollup · Chips are in-match scorekeeping, not Gemas · testnet Gemas from a simulated Position.</p>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Card large as="section">
      <div className="stack">
        <h1 className="page-title">{title}</h1>
        <p className="meta">{body}</p>
        <Button href="/">Lobby</Button>
      </div>
    </Card>
  );
}
