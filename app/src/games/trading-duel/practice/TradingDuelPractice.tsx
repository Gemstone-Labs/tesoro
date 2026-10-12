"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Label } from "@/components/ui";
import { art } from "@/lib/art";
import { ASSETS, type Asset } from "../chain";
import { assetBySymbol, midToUsd, perSecond, usePriceFeed, type PriceFeed } from "../feed";
import { usd } from "../fmt";
import { COLUMNS, MATCH_SECS, lockAt, revealed, rowOf, type GridAsset } from "../grid";
import { GridScreen } from "../GridScreen";
import { seededRng } from "./bot";
import { elapsed, newGridSession, setPick, stepGridSession, type GridSession } from "./gridSession";
import "../trading.css";
import { Arena, MuteToggle } from "../../fx";

/** The bot's face in practice: a fixed gemstone animal, labelled "Bot". */
const YOU = { name: "You", avatar: art.avatars[0] };
const BOT = { name: "Bot", avatar: art.avatars[4] };

/**
 * Trading Duel practice: the real grid screen on the live price against a local bot. Nothing is
 * staked, there is no wallet and no chain. `?asset=eth` and `?seed=7` (a fixed bot) are honoured.
 */
export function TradingDuelPractice() {
  const sp = useSearchParams();
  const [asset, setAsset] = useState<Asset>(() => assetBySymbol(sp.get("asset")));
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

  const start = () => {
    const mid = store.tick?.mid;
    if (mid === undefined) return;
    rng.current = seed ? seededRng(Number(seed) || 1) : () => Math.random();
    setError(null);
    commit(newGridSession(Date.now(), mid, asset.symbol as GridAsset, rng.current));
  };

  if (!session) return <Picker asset={asset} setAsset={setAsset} feed={feed} onStart={start} />;

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
      onPick={(c, r) => {
        const cur = sessionRef.current;
        const next = cur && setPick(cur, c, r, Date.now());
        setError(next ? null : "That column just locked, so the pick didn’t count.");
        if (next) commit(next);
      }}
      onPlayAgain={() => commit(null)}
      exitHref="/lobby"
    />
  );
}

/** The rows the line has reached in each column, the bot's picks, how many columns have locked and whether the game is over: what the screen draws that is not time. */
function lineSignature(s: GridSession, t: number): string {
  const rows = Array.from({ length: COLUMNS }, (_, c) => (s.track.seen[c] ? `${rowOf(s.track.lo[c], s.anchor, s.step)}-${rowOf(s.track.hi[c], s.anchor, s.step)}` : "."));
  const locked = Array.from({ length: COLUMNS }, (_, c) => c).filter((c) => t >= lockAt(c)).length;
  return `${rows.join()}|${s.picks[1].join()}|${locked}|${s.final ? 1 : 0}`;
}

function Picker({ asset, setAsset, feed, onStart }: { asset: Asset; setAsset: (a: Asset) => void; feed: PriceFeed; onStart: () => void }) {
  const ready = !!feed.tick && feed.status === "live";
  const price = feed.tick ? usd(midToUsd(feed.tick.mid), asset) : "…";
  return (
    <Arena game="trading-duel">
      <section className="td" aria-label="Trading Duel practice">
        <div className="cut cut-frame td-card" style={{ maxWidth: 560, margin: "0 auto", width: "100%", gap: 16 }}>
          <div className="td-head-l">
            <h1 className="td-title">Trading Duel practice</h1>
            <MuteToggle />
          </div>
          <p className="meta">
            Pick where the price will be. Each box is a stretch of price and a ten second column: when the live line passes through your box, you score 100
            points. You have 12 columns over two and a half minutes; more points than the bot wins. Nothing is staked and no Gemas move.
          </p>
          <div className="stack">
            <Label>Asset</Label>
            <div className="td-pick" role="group" aria-label="Asset">
              {ASSETS.map((a) => (
                <button key={a.id} type="button" className="cut cut-btn" aria-pressed={a.id === asset.id} onClick={() => setAsset(a)}>
                  {a.symbol}
                </button>
              ))}
            </div>
            <p className="meta mono" role="status">
              {asset.symbol}/USD {price} {ready ? "· live" : "· connecting to live prices…"}
            </p>
          </div>
          <div className="td-banner-row">
            <Button variant="neutral" size="lg" onClick={onStart} disabled={!ready}>Start practice</Button>
            <Button href="/play/trading-duel">Back</Button>
          </div>
        </div>
      </section>
    </Arena>
  );
}

