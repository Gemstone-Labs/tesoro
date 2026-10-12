"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Dumbbell, UserPlus, Users } from "lucide-react";
import { AccountLink } from "@/components/account/AccountLink";
import { MatchBanner } from "@/components/match/MatchBanner";
import { AssetPicker, BustCard, Button, EntryPicker } from "@/components/ui";
import { gameQuery, practiceHref } from "@/lib/game-params";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { accountHistory } from "@/lib/chain/history";
import { useTopScoresToday } from "@/lib/chain/useRecentSettled";
import { fmtGemas } from "@/lib/format";
import { useQueue } from "@/components/lobby/useQueue";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import "./game.css";
import { PlayerAvatar } from "@/components/account/Player";

const COPY: Record<GameId, { tag: string; sub: string[]; how: string; steps: string[]; hero: string }> = {
  "block-puzzle": {
    tag: "Head-to-head · Async",
    sub: ["Same pieces as your opponent · 90 s · higher score wins", "Pieces stay hidden until you press Start"],
    how: "Same pieces. Same chance.",
    steps: ["Same pieces as your opponent", "90 seconds · higher score wins", "Pieces stay hidden until you press Start"],
    hero: art.blockPuzzleHero,
  },
  holdem: {
    tag: "Cards · Head-to-head",
    sub: ["Real-time · 2 players · Turbo blinds", "Chips are scorekeeping inside the Match, not Gemas"],
    how: "Heads-up, no limit.",
    steps: ["1,500 Chips each, blinds rise every hand", "30 seconds per action", "Last stack standing takes the Pot minus Fees"],
    hero: art.holdemHero,
  },
  "trading-duel": {
    tag: "Head-to-head · Real-time",
    sub: ["Real-time · 2.5 minutes · live prices · more points wins", "Your picks stay hidden from your opponent until each column locks"],
    how: "Same market. One pick per column.",
    steps: ["12 columns of ten seconds on a live price, with a 30 second head start", "Pick one box per column; the line passing through it scores 100 points", "More points takes the Pot minus Fees; a tie refunds both"],
    hero: art.tradingDuelHero,
  },
};

export function GamePage({ game }: { game: GameId }) {
  const { snapshot, onChain, auth } = useAccount();
  const router = useRouter();
  const [entry, setEntry] = useState<EntrySize>(game === "block-puzzle" ? 1000 : 500);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const top = useTopScoresToday(game === "block-puzzle");
  const queue = useQueue();
  const [now] = useState(() => Date.now());
  const copy = COPY[game];
  const name = GAME_NAMES[game];

  const history = useMemo(() => (onChain && snapshot ? accountHistory(snapshot.matches, snapshot.funded).filter((r) => r.game === game) : []), [onChain, snapshot, game]);
  const mine = history.slice(0, 3);
  const scores = top.data ?? [];

  const me = snapshot?.accountKey.toBase58();
  /** Other Players in the Queue at this entry (and asset): who Play now would meet. */
  const waiting = queue?.[game].filter((w) => w.player !== me && w.entry === entry && (game !== "trading-duel" || w.asset === asset)).length ?? 0;

  const query = (kind: "queue" | "challenge") => `/play/${kind}?${gameQuery(game, asset)}entry=${entry}`;

  return (
    <div className="gp">
      <section className="cut cut-frame gp-hero" aria-label={name}>
        <Image className="gp-hero-art" src={copy.hero} alt="" fill sizes="(min-width: 1024px) 1400px, 100vw" priority />
        <span className="sparkles" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
        <div className="gp-hero-body">
          <h1 className="gp-title">{name}</h1>
          <p className="gp-sub">
            {copy.sub[0]}
          </p>
          {game === "trading-duel" && <AssetPicker value={asset} onChange={setAsset} name="gp-asset" />}
          <EntryPicker value={entry} onChange={setEntry} name={`gp-entry-${game}`} />
          <div className="gp-cta">
            <Button variant="money" size="lg" block onClick={() => auth.gate("Enter a Match", () => router.push(query("queue")))}>
              <span className="gp-play-label">Play now</span>
              <span className="gp-play-sub">
                {fmtGemas(entry)} Gemas
                {waiting ? (
                  <>
                    {" · "}
                    <Users aria-hidden="true" /> {waiting} waiting
                  </>
                ) : null}
              </span>
            </Button>
            <div className="gp-more">
              <Button size="lg" onClick={() => auth.gate("Challenge a friend", () => router.push(query("challenge")))}>
                <UserPlus aria-hidden="true" />
                <span>
                  Challenge<span className="gp-friend"> a friend</span>
                </span>
              </Button>
              <Button size="lg" href={practiceHref(game, asset)}>
                <Dumbbell aria-hidden="true" />
                Practice free
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div className="gp-grid">
        <section className="cut cut-frame gp-panel" aria-labelledby="gp-recent">
          <header className="gp-head">
            <h2 id="gp-recent" className="h-section">Recent Matches</h2>
            {history.length > 0 && (
              <Link href={`/matches?game=${game}`} className="gp-all">
                See all {history.length} <ArrowRight aria-hidden="true" />
              </Link>
            )}
          </header>
          {mine.length === 0 || !me ? (
            <p className="meta gp-empty">
              {onChain
                ? `No finished ${name} Matches yet. Yours appear here when they finish.`
                : auth.status === "signed-out"
                  ? "Sign in to see your Matches."
                  : "Loading your Matches…"}
            </p>
          ) : (
            <div className="mb-list">
              {mine.map((r) => (
                <MatchBanner key={r.id} r={r} account={me} now={now} me={me} />
              ))}
            </div>
          )}
          {top.error && scores.length === 0 && (
            <p className="meta gp-empty" role="status">
              Top scores today could not be read from Solana devnet. Retrying every 30 seconds.
            </p>
          )}
          {scores.length > 0 && (
            <div className="gp-top-wrap" role="group" aria-labelledby="gp-top">
              <header>
                <h3 id="gp-top" className="gp-sub-h">Top scores today</h3>
              </header>
              {scores.map(([key, score], i) => (
                <div key={key} className="cut cut-card gp-top">
                  <b className="gp-rank">{i + 1}</b>
                  <PlayerAvatar className="gp-av" account={key} size={44} />
                  <AccountLink account={key} className="gp-topname" />
                  <b className="tnum gp-score">{score}</b>
                </div>
              ))}
              <p className="note">
                {top.error ? "Couldn’t refresh; showing what was last loaded. " : ""}Best winning score per Player in the last 24 hours, from settled
                Matches on Solana devnet.
              </p>
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
