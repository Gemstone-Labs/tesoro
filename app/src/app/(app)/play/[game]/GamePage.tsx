"use client";

import { getImageProps } from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Dumbbell, Info, UserPlus, Users } from "lucide-react";
import { AccountLink } from "@/components/account/AccountLink";
import { MatchBanner, MatchBannerSkeleton } from "@/components/match/MatchBanner";
import { AssetPicker, Button, EntryPicker, GemaMark, Sheet } from "@/components/ui";
import { gameQuery, practiceHref } from "@/lib/game-params";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { CATALOGUE } from "@/lib/catalogue";
import { PLAYED, accountHistory } from "@/lib/chain/history";
import { useChainData } from "@/lib/chain/ChainDataProvider";
import { useTopScoresToday } from "@/lib/chain/useRecentSettled";
import { estimatedWin } from "@/lib/chain/ledger";
import { fmtGemas } from "@/lib/format";
import { awayNotice } from "@/lib/chain/protections";
import { useAway } from "@/lib/chain/useAway";
import { useQueue } from "@/components/lobby/useQueue";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import "./game.css";
import { PlayerAvatar } from "@/components/account/Player";

const COPY: Record<GameId, { tag: string; sub: string[]; how: string; steps: string[]; hero: string }> = {
  "block-puzzle": {
    tag: "Head-to-head · Live",
    sub: ["Same pieces, same time · 90 s · higher score wins", "Pieces stay hidden until the countdown ends"],
    how: "Same pieces. Same chance.",
    steps: ["Same pieces as your opponent, at the same time", "90 seconds · higher score wins", "Pieces stay hidden until the countdown ends"],
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
  vanguard: {
    tag: "Head-to-head · Real-time",
    sub: ["Real-time · 10 seconds a move · capture the enemy Supply Truck", "Your pieces' ranks stay hidden from your opponent until they fight"],
    how: "Blitz Stratego on a desert board.",
    steps: ["20 pieces each on a 10×10 board, ranks hidden", "10 seconds a move; capture the Supply Truck to win", "The winner takes the Pot minus Fees; a draw refunds both"],
    hero: art.vanguardHero,
  },
};

export function GamePage({ game }: { game: GameId }) {
  const { snapshot, onChain, auth } = useAccount();
  const { error, refresh } = useChainData();
  const router = useRouter();
  const [entry, setEntry] = useState<EntrySize>(game === "block-puzzle" ? 1000 : 500);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const [how, setHow] = useState(false);
  const top = useTopScoresToday(game === "block-puzzle");
  const queue = useQueue();
  const [now] = useState(() => Date.now());
  const copy = COPY[game];
  const name = GAME_NAMES[game];
  const { props: desktopArt } = getImageProps({ src: copy.hero, alt: "", fill: true, sizes: "900px" });
  const { props: tileArt } = getImageProps({
    src: CATALOGUE.find((entry) => entry.game === game)!.tile,
    alt: "", fill: true, sizes: "100vw", loading: "eager", fetchPriority: "high",
  });

  const history = useMemo(() => (onChain && snapshot ? accountHistory(snapshot.matches, snapshot.funded).filter((r) => r.game === game && PLAYED.includes(r.result)) : []), [onChain, snapshot, game]);
  const mine = history.slice(0, 3);
  const scores = top.data ?? [];

  const me = snapshot?.accountKey.toBase58();
  const away = useAway();
  const awayText = away ? awayNotice(away) : null;
  /** Other Players in the Queue at this entry (and asset): who Play now would meet. */
  const waiting = queue?.[game].filter((w) => w.player !== me && w.entry === entry && (game !== "trading-duel" || w.asset === asset)).length ?? 0;

  const query = (kind: "queue" | "challenge") => `/play/${kind}?${gameQuery(game, asset)}entry=${entry}`;

  return (
    <div className="gp">
      <section className="cut cut-frame gp-hero" aria-label={name}>
        <div className="gp-art">
          <picture>
            <source media="(min-width: 1024px)" srcSet={desktopArt.srcSet} sizes={desktopArt.sizes} />
            <img {...tileArt} alt="" className="gp-hero-art" />
          </picture>
          <span className="sparkles" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <div className="gp-art-title">
            <h1 className="gp-title">{name}</h1>
            <button type="button" className="gp-info" aria-label={`How to play ${name}`} onClick={() => setHow(true)}>
              <Info aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="cut cut-frame gp-hero-body">
          {/* desktop: the name sits over the art's dark side with the panel under it (phones show it on the art above) */}
          <div className="gp-body-title">
            <h1 className="gp-title">{name}</h1>
            <button type="button" className="gp-info" aria-label={`How to play ${name}`} onClick={() => setHow(true)}>
              <Info aria-hidden="true" />
            </button>
          </div>
          {game === "trading-duel" && <AssetPicker value={asset} onChange={setAsset} name="gp-asset" />}
          <EntryPicker value={entry} onChange={setEntry} name={`gp-entry-${game}`} />
          <div className="gp-cta">
            {awayText ? (
              <p className="status" role="status">{awayText}</p>
            ) : (
              <Button variant="money" size="lg" block onClick={() => auth.gate("Enter a Match", () => router.push(query("queue")))}>
                <span className="gp-play-label">Play now</span>
                <span className="gp-play-sub">
                  {waiting ? (
                    <>
                      <Users aria-hidden="true" /> {waiting} waiting ·{" "}
                    </>
                  ) : null}
                  win <GemaMark size={13} /> {fmtGemas(estimatedWin(entry))}
                </span>
              </Button>
            )}
            <div className="gp-more">
              {!awayText && (
                <Button onClick={() => auth.gate("Challenge a friend", () => router.push(query("challenge")))}>
                  <UserPlus aria-hidden="true" />
                  Challenge a friend
                </Button>
              )}
              <Button href={practiceHref(game, asset)}>
                <Dumbbell aria-hidden="true" />
                Practice free
              </Button>
            </div>
          </div>
        </div>
      </section>

      <Sheet open={how} onClose={() => setHow(false)} title={`How to play ${name}`} className="gp-how-sheet">
        <div className="gp-how">
          <p className="gp-how-sub">{copy.sub.join(" · ")}</p>
          <b>{copy.how}</b>
          <ol>
            {copy.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      </Sheet>

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
          {auth.status === "loading" || (onChain && !snapshot?.matchesLoaded) ? (
            error ? (
              <p className="status err" role="alert">
                Your Matches couldn’t load. <Button size="sm" onClick={() => void refresh()}>Try again</Button>
              </p>
            ) : <MatchBannerSkeleton count={3} label="Loading your recent Matches…" />
          ) : mine.length === 0 || !me ? (
            <p className="meta gp-empty">
              {onChain
                ? `No finished ${name} Matches yet. Yours appear here when they finish.`
                : "Sign in to see your Matches."}
            </p>
          ) : (
            <div className="mb-list">
              {mine.map((r) => (
                <MatchBanner key={r.id} r={r} account={me} now={now} me={me} />
              ))}
            </div>
          )}
          {game === "block-puzzle" && !top.data && !top.error && (
            <div className="gp-top-wrap" aria-busy="true" aria-label="Loading top scores today">
              <h3 className="gp-sub-h">Top scores today</h3>
              {[0, 1, 2].map((i) => (
                <div key={i} className="cut cut-card gp-top skel" aria-hidden="true">
                  <span className="skel-line" />
                  <span className="gp-av skel-av" />
                  <span className="skel-line" />
                  <span className="skel-line" style={{ width: 44 }} />
                </div>
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

      </div>
    </div>
  );
}
