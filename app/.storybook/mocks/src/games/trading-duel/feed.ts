// Storybook: the oracle price is a deterministic walk that still ticks ten times a second, so charts move and the screen never goes stale.
import { useEffect, useState } from "react";
import { PriceStore, usdToMid, type PriceFeed } from "../../../../../src/games/trading-duel/feed";
import type { Asset } from "../../../../../src/games/trading-duel/chain";

export * from "../../../../../src/games/trading-duel/feed";

const BASE = { SOL: 142.5, ETH: 3180, HYPE: 28.4 } as const;

const hash = (k: number) => {
  const x = Math.sin(k * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** USD price of `asset` at `t` ms: slow swells, a faster ripple and a little noise per second. */
export function syntheticPrice(symbol: Asset["symbol"], t: number): number {
  return (
    BASE[symbol] *
    (1 + 0.004 * Math.sin(t / 37_000) + 0.0025 * Math.sin(t / 9_300 + 1.3) + 0.0012 * Math.sin(t / 2_900 + 0.4) + 0.0007 * (hash(Math.floor(t / 1000)) - 0.5))
  );
}

const BEAT_MS = 100;

export function usePriceFeed(asset: Asset | null, enabled = true): PriceFeed {
  const [store] = useState(() => new PriceStore());
  const [snap, setSnap] = useState<Pick<PriceFeed, "tick" | "status">>({ tick: null, status: "waiting" });
  useEffect(() => {
    if (!asset || !enabled) return;
    const ingest = (t: number) => store.ingest(usdToMid(syntheticPrice(asset.symbol, t)), Math.floor(t / 1000), t);
    store.clear();
    const now = Date.now();
    for (let i = 60; i > 0; i--) ingest(now - i * 1000);
    const read = () => setSnap({ tick: store.tick, status: store.tick ? "live" : "waiting" });
    const beat = setInterval(() => ingest(Date.now()), BEAT_MS);
    const first = setTimeout(read, 0);
    const i = setInterval(read, 250);
    return () => {
      clearInterval(beat);
      clearTimeout(first);
      clearInterval(i);
    };
  }, [asset, enabled, store]);
  return { ...snap, series: store, store };
}
