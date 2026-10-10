// Storybook: the oracle price is a deterministic walk that still ticks once a second, so charts move and the screen never goes stale.
import { useEffect, useState } from "react";
import { pushPoint, usdToMid, type PriceFeed, type Tick } from "../../../../../src/games/trading-duel/feed";
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

function at(symbol: Asset["symbol"], t: number) {
  return { t, p: syntheticPrice(symbol, t) };
}

function initial(asset: Asset | null): PriceFeed {
  if (!asset) return { tick: null, series: [], status: "waiting" };
  const now = Date.now();
  const series = Array.from({ length: 61 }, (_, i) => at(asset.symbol, now - (60 - i) * 1000));
  const tick: Tick = { mid: usdToMid(series[60].p), publishedAt: Math.floor(now / 1000), receivedAt: now };
  return { tick, series, status: "live" };
}

export function usePriceFeed(asset: Asset | null, enabled = true): PriceFeed {
  const [feed, setFeed] = useState<PriceFeed>(() => initial(enabled ? asset : null));
  useEffect(() => {
    if (!asset || !enabled) return;
    const timer = setTimeout(() => setFeed(initial(asset)), 0);
    const i = setInterval(() => {
      const now = Date.now();
      const pt = at(asset.symbol, now);
      setFeed((f) => ({ tick: { mid: usdToMid(pt.p), publishedAt: Math.floor(now / 1000), receivedAt: now }, series: pushPoint(f.series, pt), status: "live" }));
    }, 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(i);
    };
  }, [asset, enabled]);
  return feed;
}
