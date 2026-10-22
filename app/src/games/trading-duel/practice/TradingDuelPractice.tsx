"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";
import { art } from "@/lib/art";
import { ASSETS, type Asset } from "../chain";
import { perSecond, usePriceFeed } from "../feed";
import { COLUMNS, MATCH_SECS, lockAt, revealed, bandOf, type GridAsset } from "../grid";
import { GridScreen } from "../GridScreen";
import { seededRng } from "./bot";
import { elapsed, newGridSession, setPick, stepGridSession, type GridSession } from "./gridSession";
import "../trading.css";
import { Arena, FullScreenToggle, MuteToggle } from "../../fx";

/** The bot's face in practice: a fixed gemstone animal, labelled "Bot". */
const YOU = { name: "You", avatar: art.avatars[0] };
const BOT = { name: "Bot", avatar: art.avatars[4] };

/** Practice always plays SOL. */
const PRACTICE_ASSET: Asset = ASSETS[0];

/**
 * Trading Duel practice: the real grid screen on the live SOL price against a local bot. Nothing is
 * staked, there is no wallet and no chain. It starts as soon as the first live price lands; `?seed=7`
 * gives a fixed bot.
 */
export function TradingDuelPractice() {
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
  const feed = usePriceFeed(asset, true, !session);
  const seed = sp.get("seed");
  const rng = useRef<() => number>(() => Math.random());
  const prices = useRef<number[]>([]);
  const store = feed.store;

  useEffect(() => {
    if (!error) return;
    const i = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(i);
  }, [error]);

  // Every reading the feed makes goes into the track (about 20 a second), so a hit matches the line you see.
  // The screen hears about the game when something it shows changes, and once a second.
  const startsAt = session?.startsAt;
  useEffect(() => {
    if (!startsAt) return;
    const off = store.onUpdate((tick) => {
      const s = sessionRef.current;
      if (s && !s.final) sessionRef.current = stepGridSession(s, tick.mid, tick.receivedAt, rng.current, prices.current);
    });
    let shown = "";
    let shownAt = 0;
    const i = setInterval(() => {
      const now = Date.now();
      const s = sessionRef.current;
      prices.current = perSecond(store.points);
      if (!s || !store.tick) return;
      const next = stepGridSession(s, store.tick.mid, now, rng.current, prices.current);
      sessionRef.current = next;
      // The screen re-renders when what it shows changes (a box lit, a pick revealed, the end) and at least once a second.
      const sig = lineSignature(next, elapsed(next, now));
      if (sig !== shown || now - shownAt >= 1000) {
        shown = sig;
        shownAt = now;
        setClock(now);
        setSession(next);
      }
    }, 250);
    return () => {
      off();
      clearInterval(i);
    };
  }, [startsAt, store]);

  // Start (and Play again) on the next live price: no picker, no button.
  const waiting = !session;
  useEffect(() => {
    if (!waiting) return;
    const off = store.onUpdate((tick) => {
      if (sessionRef.current) return;
      rng.current = seed ? seededRng(Number(seed) || 1) : () => Math.random();
      commit(newGridSession(Date.now(), tick.mid, asset.symbol as GridAsset, rng.current));
    });
    return off;
  }, [waiting, store, seed, asset]);

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
      series={feed.series}
      stale={feed.status === "stale"}
      mine={session.picks[0]}
      theirs={revealed(session.picks[1], Math.min(t, MATCH_SECS))}
      me={YOU}
      opponent={BOT}
      final={final ? { you: final.scores[0], them: final.scores[1] } : null}
      practice
      title="Trading Duel practice"
      error={error}
      onPick={(c, k) => {
        const cur = sessionRef.current;
        const next = cur && setPick(cur, c, k, Date.now());
        setError(next ? null : "That column just locked, so the pick didn’t count.");
        if (next) commit(next);
      }}
      onPlayAgain={() => {
        setError(null);
        commit(null);
      }}
      exitHref="/lobby"
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
