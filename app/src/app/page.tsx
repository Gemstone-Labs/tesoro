"use client";

import { useState } from "react";
import { BlockBoard } from "@/components/game/BlockBoard";
import { Button, Card, EntryPicker, Label, Row, Thumb } from "@/components/ui";
import { useAccount, useBacking } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES, queueDepth } from "@/lib/mock";
import type { EntrySize } from "@/lib/mock";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Lobby() {
  const { gemas, auth } = useAccount();
  const router = useRouter();
  const { requests } = useBacking();
  const [entry, setEntry] = useState<EntrySize>(1000);
  const signedIn = auth.status === "signed-in" || auth.status === "unconfigured";
  const canEnter = !signedIn || gemas.total >= entry;
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
              onClick={() => enter(`/play?game=block-puzzle&entry=${entry}`)}
              disabled={!canEnter}
            >
              Enter · {fmtGemas(entry)} Gemas
            </Button>
            <span className="meta">{queueDepth["block-puzzle"]} in Queue · you may play before an opponent is paired</span>
          </div>
        </Card>

        <Row
          onClick={() => enter("/play?game=holdem&entry=500")}
          thumb={<Thumb variant="poker">A♠K</Thumb>}
          title={GAME_NAMES.holdem}
          meta={`Live · ${queueDepth.holdem} in Queue`}
          cta="Play"
        />
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
