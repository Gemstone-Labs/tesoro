"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";
import { art } from "@/lib/art";
import { ASSETS, type Asset } from "../chain";
import { PriceStore, perSecond, usdToMid, usePriceFeed } from "../feed";
import { COLUMNS, MATCH_SECS, lockAt, revealed, bandOf, type GridAsset } from "../grid";
import { GridScreen } from "../GridScreen";
import { seededRng } from "./bot";
import { FALLBACK_START_USD, simulatedMid } from "./simPrice";
import { elapsed, newGridSession, setPick, stepGridSession, type GridSession } from "./gridSession";
import { usePracticePause } from "../../fx/PracticePause";
import "../trading.css";
import { Arena, FullScreenToggle, MuteToggle } from "../../fx";

/** The bot's face in practice: a fixed gemstone animal, labelled "Bot". */
const YOU = { name: "You", avatar: art.avatars[0] };
const BOT = { name: "Bot", avatar: art.avatars[4] };

/** How long Practice waits for the live price before it starts on a fixed one (ms). */
const FEED_WAIT_MS = 4000;

/** Practice always plays SOL. */
const PRACTICE_ASSET: Asset = ASSETS[0];

/**
 * Trading Duel practice: the real grid screen against a local bot, on a seeded simulated SOL price that
 * starts at the live price (read once; a fixed price when the feed does not answer). Nothing is staked,
 * there is no wallet and no chain. `?seed=7` fixes both the bot and the price path.
 */
export function TradingDuelPractice() {
  const { paused, toggle: togglePause, now: practiceNow } = usePracticePause();
  const [practiceStore] = useState(() => new PriceStore());
  const sp = useSearchParams();
  const asset = PRACTICE_ASSET;
  const [session, setSession] = useState<GridSession | null>(null);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<GridSession | null>(null);
  const commit = (next: GridSession | null) => {
    sessionRef.current = next;
    setSession(next);
  };
  const feed = usePriceFeed(asset, !session, !session);
  const seedParam = sp.get("seed");
  const rng = useRef<() => number>(() => Math.random());
  const simSeed = useRef(1);
  const prices = useRef<number[]>([]);
  const store = feed.store;

  useEffect(() => {
    if (!error) return;
    const i = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(i);
  }, [error]);

  // The live price is read once, for the start. After that the price is simulated from the Practice clock
  // (`simulatedMid`), so a pause freezes the line and a resume continues it. The simulated price goes into the
  // track about 20 times a second, so a hit matches the line you see. The screen hears about the game when
  // something it shows changes, and once a second.
  const startsAt = session?.startsAt;
  useEffect(() => {
    if (!startsAt || paused) return;
    let shown = "";
    let shownAt = 0;
    const i = setInterval(() => {
      const now = practiceNow();
      let s = sessionRef.current;
      if (!s) return;
      if (!s.final) {
        const mid = simulatedMid(simSeed.current, s.anchor, asset.symbol as GridAsset, Math.max(0, elapsed(s, now)));
        practiceStore.ingest(mid, Math.floor(now / 1000), now);
        prices.current = perSecond(practiceStore.points);
        s = stepGridSession(s, mid, now, rng.current, prices.current);
        sessionRef.current = s;
      }
      // The screen re-renders when what it shows changes (a box lit, a pick revealed, the end) and at least once a second.
      const sig = lineSignature(s, elapsed(s, now));
      if (sig !== shown || now - shownAt >= 1000) {
        shown = sig;
        shownAt = now;
        setClock(now);
        setSession(s);
      }
    }, 50);
    return () => clearInterval(i);
  }, [startsAt, paused, practiceNow, practiceStore, asset]);

  // Start (and Play again) on the first live price, or on a fixed price when the feed has not answered in a few seconds.
  const waiting = !session;
  useEffect(() => {
    if (!waiting) return;
    const begin = (mid: bigint) => {
      if (sessionRef.current) return;
      rng.current = seedParam ? seededRng(Number(seedParam) || 1) : () => Math.random();
      simSeed.current = seedParam ? Number(seedParam) || 1 : Math.floor(Math.random() * 2 ** 31);
      const now = practiceNow();
      practiceStore.clear();
      practiceStore.ingest(mid, Math.floor(now / 1000), now);
      commit(newGridSession(now, mid, asset.symbol as GridAsset, rng.current));
    };
    const off = store.onUpdate((tick) => begin(tick.mid));
    const fallback = setTimeout(() => begin(usdToMid(FALLBACK_START_USD[asset.symbol as GridAsset])), FEED_WAIT_MS);
    if (store.tick) begin(store.tick.mid);
    return () => {
      off();
      clearTimeout(fallback);
    };
  }, [waiting, store, seedParam, asset, practiceNow, practiceStore]);

  if (!session) return <Connecting asset={asset} stale={feed.status === "stale"} />;

  const t = elapsed(session, clock || session.startsAt);
  const final = session.final;
  return (
    <GridScreen
      asset={asset.symbol as GridAsset}
      anchor={session.anchor}
      step={session.step}
      startsAt={session.startsAt}
      track={session.track}
      series={practiceStore}
      stale={false}
      mine={session.picks[0]}
      theirs={revealed(session.picks[1], Math.min(t, MATCH_SECS))}
      me={YOU}
      opponent={BOT}
      final={final ? { you: final.scores[0], them: final.scores[1] } : null}
      practice
      paused={paused}
      onTogglePause={togglePause}
      practiceNow={practiceNow}
      title="Trading Duel practice"
      error={error}
      onPick={(c, k) => {
        if (paused) return;
        const cur = sessionRef.current;
        const next = cur && setPick(cur, c, k, practiceNow());
        setError(next ? null : "That column just locked, so the pick didn’t count.");
        if (next) commit(next);
      }}
      onPlayAgain={() => {
        setError(null);
        commit(null);
      }}
      exitHref="/play"
    />
  );
}

/** The bands the line has reached in each column, the bot's picks, how many columns have locked and whether the game is over: what the screen draws that is not time. */
function lineSignature(s: GridSession, t: number): string {
  const bands = Array.from({ length: COLUMNS }, (_, c) => (s.track.seen[c] ? `${bandOf(s.track.lo[c], s.anchor, s.step)}-${bandOf(s.track.hi[c], s.anchor, s.step)}` : "."));
  const locked = Array.from({ length: COLUMNS }, (_, c) => c).filter((c) => t >= lockAt(c)).length;
  return `${bands.join()}|${s.picks[1].join()}|${locked}|${s.final ? 1 : 0}`;
}

/** Shown for the moment before the first live price lands; the game starts by itself after it. */
function Connecting({ asset, stale }: { asset: Asset; stale: boolean }) {
  return (
    <Arena game="trading-duel" autoFull>
      <section className="td" aria-label="Trading Duel practice">
        <div className="cut cut-frame td-card" style={{ maxWidth: 560, margin: "0 auto", width: "100%", gap: 16 }}>
          <div className="td-head-l">
            <div className="stack" style={{ gap: 2 }}>
              <p className="td-kicker">Practice · nothing staked</p>
              <h1 className="td-title">Trading Duel</h1>
            </div>
            <MuteToggle />
            <FullScreenToggle />
          </div>
          <p className="meta mono" role="status">
            {stale ? `${asset.symbol}/USD price is late · waiting for a fresh one…` : `Getting the live ${asset.symbol}/USD price…`}
          </p>
          <div className="td-banner-row">
            <Button href="/play/trading-duel">Back</Button>
          </div>
        </div>
      </section>
    </Arena>
  );
}
