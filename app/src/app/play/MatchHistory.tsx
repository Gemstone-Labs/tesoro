"use client";

import Link from "next/link";
import { Card, ChainChip, CheckIcon, Chip, GemaAmount, Label, MinusIcon, XIcon } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { MatchResult } from "@/lib/mock";

const RESULT: Record<MatchResult, { text: string; tone: "money" | "danger" | "neutral"; icon: React.ReactNode }> = {
  won: { text: "Won", tone: "money", icon: <CheckIcon /> },
  lost: { text: "Lost", tone: "danger", icon: <XIcon /> },
  draw: { text: "Draw", tone: "neutral", icon: <MinusIcon /> },
  refunded: { text: "Refunded", tone: "neutral", icon: <MinusIcon /> },
};

export function MatchHistory() {
  const { matches, openMatches, onChain, loading } = useAccount();
  return (
    <section className="stack" aria-labelledby="mh">
      <Label><span id="mh">Match history</span></Label>
      {onChain &&
        openMatches.map((m) => (
          <Card key={m.id.toString()} as="article" aria-label="Match in progress">
            <Link href={`/play/match/${m.id.toString()}`} className="spread">
              <span className="row-body">
                <span className="row-title">{GAME_NAMES[m.game]} · in progress</span>
                <span className="row-meta">Entry {fmtGemas(m.entry)} · {m.status === "open" ? (m.game === "block-puzzle" ? "waiting to be paired" : "waiting for an opponent") : "opponent found"}</span>
              </span>
              <Chip tone="strong">Open</Chip>
            </Link>
          </Card>
        ))}
      {onChain && !loading && matches.length === 0 && openMatches.length === 0 && (
        <p className="meta">No finished Matches yet. Your Matches on Solana devnet appear here.</p>
      )}
      {matches.map((m) => {
        const r = RESULT[m.result];
        return (
          <Card key={m.id} as="article" aria-label={`${GAME_NAMES[m.game]} against ${m.opponent}`}>
            <div className="spread">
              <span className="row-body">
                <span className="row-title">{GAME_NAMES[m.game]} vs {m.opponent}</span>
                <span className="row-meta">
                  Entry {fmtGemas(m.entry)} · <span className="mono">{m.seed}</span>
                </span>
              </span>
              <span className="stack" style={{ gap: 4, justifyItems: "end" }}>
                <Chip tone={r.tone} icon={r.icon}>{r.text}</Chip>
                <GemaAmount value={m.gemasDelta} size="sm" sign />
              </span>
            </div>
          </Card>
        );
      })}
      <p className="note">
        {onChain ? "From Solana devnet." : "Example history (MOCK, sign in for yours)."} <ChainChip chain="SOL" /> settlement is on Solana devnet.
      </p>
    </section>
  );
}
