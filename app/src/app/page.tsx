"use client";

import { useEffect, useState } from "react";
import { BlockBoard } from "@/components/game/BlockBoard";
import { Button, Card, EntryPicker, Label, Row, Thumb } from "@/components/ui";
import { useAccount, useBacking } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES, queueDepth as mockQueueDepth } from "@/lib/mock";
import type { EntrySize } from "@/lib/mock";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Lobby() {
  const { gemas, auth, onChain, openMatches, loading } = useAccount();
  const router = useRouter();
  const [waiting, setWaiting] = useState<number | null>(null);
  const [waitingHoldem, setWaitingHoldem] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    import("@/lib/chain/read")
      .then(async (m) => [await m.queueDepth("block-puzzle"), await m.queueDepth("holdem")] as const)
      .then(([bp, hd]) => {
        if (!live) return;
        setWaiting(bp);
        setWaitingHoldem(hd);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const queueDepth = { ...mockQueueDepth, "block-puzzle": waiting ?? mockQueueDepth["block-puzzle"], holdem: waitingHoldem ?? mockQueueDepth.holdem };
  const { requests } = useBacking();
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [holdemEntry, setHoldemEntry] = useState<EntrySize>(500);
  const signedIn = auth.status === "signed-in" || auth.status === "unconfigured";
  const canEnter = !signedIn || loading || gemas.total >= entry;
  const canEnterHoldem = !signedIn || loading || gemas.total >= holdemEntry;
  const enter = (href: string) => auth.gate("Enter a Match", () => router.push(href));

  return (
    <div className="cols cols-2">
      <div className="stack-lg">
        <Card flush as="section" aria-label="Featured game">
          <BlockBoard />
          <div className="feature-body">
            <div className="stack" style={{ gap: 4 }}>
              <h2>{GAME_NAMES["block-puzzle"]}</h2>
              <span className="meta">Same Seed as your opponent · 90 seconds · higher score wins</span>
            </div>
            <EntryPicker value={entry} onChange={setEntry} legend="Entry for Block Puzzle" maxAffordable={signedIn ? gemas.total : undefined} />
            <Button
              variant="money"
              block
              onClick={() => enter(`/play/queue?entry=${entry}`)}
              disabled={!canEnter}
            >
              Enter · {fmtGemas(entry)} Gemas
            </Button>
            {!canEnter && onChain && (
              <span className="meta">
                You need {fmtGemas(entry)} Gemas to enter. <Link href="/wallet">Get Gemas in your Wallet</Link>
              </span>
            )}
            <span className="meta">
              {queueDepth["block-puzzle"]} waiting in Queue · play starts as soon as an opponent is paired
            </span>
            <div className="hstack wrap">
              <Button size="sm" onClick={() => auth.gate("Challenge a friend", () => router.push(`/play/challenge?entry=${entry}`))}>
                Challenge a friend
              </Button>
              <Button size="sm" href="/play?game=block-puzzle">Practice, no Gemas</Button>
            </div>
          </div>
        </Card>

        {openMatches.length > 0 && (
          <section className="stack" aria-label="Your Matches in progress">
            <Label>Your Matches in progress</Label>
            {openMatches.map((m) => (
              <Row
                key={m.id.toString()}
                href={`/play/match/${m.id.toString()}`}
                thumb={<Thumb>{m.entry >= 1000 ? `${m.entry / 1000}K` : m.entry}</Thumb>}
                title={`${GAME_NAMES[m.game]} · ${fmtGemas(m.entry)} entry`}
                meta={m.status === "open" ? (m.challenge ? "Waiting for your Challenge to be opened" : "Waiting for an opponent") : "Opponent found · continue"}
                cta="Open"
              />
            ))}
          </section>
        )}

        <Card as="section" aria-label="Heads-up Hold'em">
          <div className="stack">
            <div className="hstack">
              <Thumb variant="poker">A♠K</Thumb>
              <span className="row-body">
                <h2 className="row-title">{GAME_NAMES.holdem}</h2>
                <span className="row-meta">Live · 30 s per action · Turbo blinds</span>
              </span>
            </div>
            <EntryPicker value={holdemEntry} onChange={setHoldemEntry} legend="Entry for Hold'em" name="holdem-entry" maxAffordable={signedIn ? gemas.total : undefined} />
            <Button variant="money" block onClick={() => enter(`/play/queue?game=holdem&entry=${holdemEntry}`)} disabled={!canEnterHoldem}>
              Enter · {fmtGemas(holdemEntry)} Gemas
            </Button>
            {!canEnterHoldem && onChain && (
              <span className="meta">
                You need {fmtGemas(holdemEntry)} Gemas to enter. <Link href="/wallet">Get Gemas in your Wallet</Link>
              </span>
            )}
            <span className="meta">{queueDepth.holdem} waiting in Queue · play starts when an opponent sits down</span>
            <div className="hstack wrap">
              <Button size="sm" onClick={() => auth.gate("Challenge a friend", () => router.push(`/play/challenge?game=holdem&entry=${holdemEntry}`))}>
                Challenge a friend
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <section className="stack" aria-labelledby="req-h">
        <div className="section-head">
          <Label>
            <span id="req-h">Back a Player</span>
          </Label>
          <Link href="/backing">See all</Link>
        </div>
        {requests.map((r) => (
          <Row
            key={r.id}
            href={`/backing#${r.id}`}
            thumb={<Thumb>{r.player.name[0]}</Thumb>}
            title={`${r.player.name} asks for ${fmtGemas(r.entry)}`}
            meta={`${GAME_NAMES[r.game]} · ${r.player.matches} Matches · ${Math.round(r.player.winRate * 100)}% won`}
            cta="Offer"
            ctaTone="money"
          />
        ))}
      </section>
    </div>
  );
}
