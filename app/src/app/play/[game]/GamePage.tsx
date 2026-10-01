"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronRight, Clock, Link2 } from "lucide-react";
import { toPlayed, type Played } from "@/components/lobby/PlayAgainRail";
import { BustCard, Button, CheckIcon, EntryPicker, GemaMark, MinusIcon, XIcon } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art, avatarFor } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { useRecentSettled } from "@/lib/chain/useRecentSettled";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import "./game.css";

const COPY: Record<GameId, { tag: string; sub: string[]; how: string; steps: string[]; hero: string }> = {
  "block-puzzle": {
    tag: "Head-to-head · Async",
    sub: ["Same Seed as your opponent · 90 s · higher score wins", "Pieces stay hidden until you press Start"],
    how: "Same Seed. Same chance.",
    steps: ["Same Seed as your opponent", "90 seconds · higher score wins", "Pieces stay hidden until you press Start"],
    hero: art.blockPuzzleHero,
  },
  holdem: {
    tag: "Cards · Head-to-head",
    sub: ["Real-time · 2 players · Turbo blinds", "Chips are scorekeeping inside the Match, not Gemas"],
    how: "Heads-up, no limit.",
    steps: ["1,500 Chips each, blinds rise every hand", "30 seconds per action", "Last stack standing takes the Pot minus Fees"],
    hero: art.holdemHero,
  },
};

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const RESULT = { won: { text: "Won", Icon: CheckIcon }, lost: { text: "Lost", Icon: XIcon }, draw: { text: "Draw", Icon: MinusIcon }, refunded: { text: "Refunded", Icon: MinusIcon } } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function Recent({ p }: { p: Played }) {
  const r = RESULT[p.result];
  return (
    <Link href={`/play/match/${p.id}`} className="cut cut-card gp-match">
      <span className="gp-thumb">
        <Image src={art.thumb[p.game]} alt="" fill sizes="110px" />
      </span>
      <span className={`gp-res ${p.result}`}>
        <r.Icon aria-hidden="true" /> {r.text}
      </span>
      <span className="gp-opp">
        {p.opp && <Image className="gp-av" src={avatarFor(p.opp)} alt="" width={44} height={44} />}
        <span>
          <b>{p.opp ? short(p.opp) : "No opponent"}</b>
          <small className="tnum">{p.scores ? `${p.scores[0]} – ${p.scores[1]}` : `Entry ${fmtGemas(p.entry)}`}</small>
        </span>
      </span>
      <span className="gp-amt">
        {p.result === "won" ? (
          <b className="won">
            <GemaMark size={20} /> +{fmtGemas(p.delta)} Gemas
          </b>
        ) : p.result === "lost" ? (
          <b>−{fmtGemas(p.entry)} Gemas</b>
        ) : (
          <b>Entry returned</b>
        )}
        <small>{ago(p.at)}</small>
      </span>
      <ChevronRight aria-hidden="true" className="gp-go" />
    </Link>
  );
}

export function GamePage({ game }: { game: GameId }) {
  const { snapshot, onChain, auth } = useAccount();
  const router = useRouter();
  const [entry, setEntry] = useState<EntrySize>(game === "holdem" ? 500 : 1000);
  const { matches: settled } = useRecentSettled(40);
  const [now] = useState(() => Date.now());
  const copy = COPY[game];
  const name = GAME_NAMES[game];

  const mine = useMemo(
    () =>
      (onChain ? (snapshot?.matches ?? []) : [])
        .map(toPlayed)
        .filter((p): p is Played => p !== null && p.game === game)
        .sort((a, b) => b.at - a.at)
        .slice(0, 3),
    [onChain, snapshot, game],
  );

  // Top scores today: the best winning score per Player among the last 24 h of settled Matches, from chain history.
  const top = useMemo(() => {
    if (game !== "block-puzzle") return [];
    const best = new Map<string, number>();
    for (const m of settled) {
      if (m.game !== "block-puzzle" || !m.scores || m.at < now - DAY_MS) continue;
      best.set(m.winner, Math.max(best.get(m.winner) ?? 0, m.scores[0]));
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [settled, game, now]);

  const query = (kind: "queue" | "challenge") => `/play/${kind}?${game === "holdem" ? "game=holdem&" : ""}entry=${entry}`;

  return (
    <div className="gp">
      <section className="cut cut-frame gp-hero" aria-label={name}>
        <Image className="gp-hero-art" src={copy.hero} alt="" fill sizes="(min-width: 1024px) 1400px, 100vw" priority />
        <div className="gp-hero-body">
          <h1 className="gp-title">{name}</h1>
          <p className="gp-sub">
            {copy.sub[0]}
          </p>
          <EntryPicker value={entry} onChange={setEntry} name={`gp-entry-${game}`} />
          <div className="gp-cta">
            <Button variant="money" size="lg" onClick={() => auth.gate("Enter a Match", () => router.push(query("queue")))}>
              Play now
            </Button>
            <Button size="lg" onClick={() => auth.gate("Challenge a friend", () => router.push(query("challenge")))}>
              Challenge a friend <Link2 aria-hidden="true" />
            </Button>
            {game === "block-puzzle" && (
              <Button size="lg" href="/play/practice">
                Practice <Clock aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </section>

      <div className="gp-grid">
        <section className="cut cut-frame gp-panel" aria-labelledby="gp-recent">
          <header className="gp-head">
            <h2 id="gp-recent" className="h-section">Recent Matches</h2>
          </header>
          {mine.length === 0 ? (
            <p className="meta gp-empty">
              {onChain ? `No finished ${name} Matches yet. Yours appear here as they settle on Solana devnet.` : "Sign in to see your Matches on Solana devnet."}
            </p>
          ) : (
            mine.map((p) => <Recent key={p.id} p={p} />)
          )}
          {top.length > 0 && (
            <div className="gp-top-wrap" role="group" aria-labelledby="gp-top">
              <header>
                <h3 id="gp-top" className="gp-sub-h">Top scores today</h3>
              </header>
              {top.map(([key, score], i) => (
                <div key={key} className="cut cut-card gp-top">
                  <b className="gp-rank">{i + 1}</b>
                  <Image className="gp-av" src={avatarFor(key)} alt="" width={44} height={44} />
                  <span className="gp-topname">{short(key)}</span>
                  <b className="tnum gp-score">{score}</b>
                </div>
              ))}
              <p className="note">Best winning score per Player in the last 24 hours, from settled Matches on Solana devnet.</p>
            </div>
          )}

        </section>

        <div className="gp-right">
          <BustCard bust="himExplain" size={190} className="gp-how">
            <h2 className="h-section">How to play</h2>
            <b>{copy.how}</b>
            <ol>
              {copy.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </BustCard>
        </div>
      </div>
    </div>
  );
}
