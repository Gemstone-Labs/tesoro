import { MATCH_SECS, type GridAsset } from "../grid";
import { seededRng } from "./bot";

/** One-second price volatility in parts per million, from the grid calibration (see `STEP_PPM` in grid.ts). */
export const SIM_SIGMA_PPM: Record<GridAsset, number> = { SOL: 67, ETH: 41, HYPE: 73 };

/** Start price in USD when the live feed never answers, so Practice still works offline. */
export const FALLBACK_START_USD: Record<GridAsset, number> = { SOL: 150, ETH: 3000, HYPE: 25 };

/** Path resolution: ten points a second, linear between them. */
const PER_SEC = 10;
const POINTS = (MATCH_SECS + 5) * PER_SEC + 2;

const normal = (rng: () => number): number => {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

/** Price multiplier path (1 at t = 0), a seeded random walk. Cached by seed and asset. */
const cache = new Map<string, Float64Array>();
function walk(seed: number, asset: GridAsset): Float64Array {
  const key = `${seed}:${asset}`;
  let path = cache.get(key);
  if (path) return path;
  const rng = seededRng((seed ^ 0x9e3779b9) + asset.charCodeAt(0) * 7919);
  const sigma = (SIM_SIGMA_PPM[asset] / 1e6) / Math.sqrt(PER_SEC);
  path = new Float64Array(POINTS);
  let x = 0;
  for (let i = 0; i < POINTS; i++) {
    path[i] = Math.exp(x);
    x += sigma * normal(rng);
  }
  if (cache.size > 16) cache.clear();
  cache.set(key, path);
  return path;
}

/**
 * The simulated price (1e-8 USD) `tSecs` seconds into a Practice game: a pure function of the seed,
 * the start price, the asset and the elapsed Practice time, so a pause freezes it and a resume continues the same path.
 */
export function simulatedMid(seed: number, startMid: bigint, asset: GridAsset, tSecs: number): bigint {
  const path = walk(seed, asset);
  const pos = Math.min(Math.max(tSecs, 0) * PER_SEC, POINTS - 2);
  const i = Math.floor(pos);
  const mult = path[i] + (path[i + 1] - path[i]) * (pos - i);
  return BigInt(Math.round(Number(startMid) * mult));
}
