/**
 * PROTOTYPE (throwaway, branch proto/wallet-many-sources-17-10-2026): a fake Account for the
 * "hundreds of Positions on the Wallet" question. Times are mainnet-like (days and months),
 * not the devnet 10-minute month. Prices are fixed. Nothing here reads the chain.
 */
import type { Chain } from "@/lib/mock/types";

export const CHAINS: Chain[] = ["SOL", "ETH", "HYPE"];
export const USD: Record<Chain, number> = { SOL: 150, ETH: 2600, HYPE: 40 };
const GEMA_USD = 0.01;
const DAY = 86_400_000;

export type OwnState = "repaying" | "paid";

/** One of the Player's own Positions: few of these, even for a heavy player. */
export interface OwnPosition {
  id: string;
  n: number;
  chain: Chain;
  principal: number;
  apy: number;
  state: OwnState;
  /** In the Position's asset. */
  debt: number;
  debtStart: number;
  unlockAt: number;
  /** Gemas Sourced from this Position the Player still holds: they can be Returned to cut its Debt. */
  ownGemas: number;
}

export type Origin = "match" | "season" | "backing";

/** Gemas the Player won, grouped by the other Player's Position they came from. These are the hundreds. */
export interface Source {
  id: string;
  chain: Chain;
  owner: string;
  origin: Origin;
  /** e.g. "Block Puzzle · 1,000" or "Season 4 payout". */
  from: string;
  wonAt: number;
  gemas: number;
  /** Gemas of this Source that are redeemable right now. */
  redeemable: number;
  /** When the whole Source is redeemable (its Position's yield has landed). */
  readyAt: number;
}

export interface Fixture {
  now: number;
  positions: OwnPosition[];
  sources: Source[];
}

export type Size = "new" | "regular" | "heavy";
export const SIZES: Size[] = ["new", "regular", "heavy"];
const COUNTS: Record<Size, { sources: number; positions: number }> = {
  new: { sources: 4, positions: 1 },
  regular: { sources: 38, positions: 3 },
  heavy: { sources: 226, positions: 9 },
};

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GEMS = ["Quartz", "Topaz", "Opal", "Jade", "Onyx", "Garnet", "Beryl", "Amber", "Ruby", "Pearl", "Agate", "Zircon"];
const ANIMALS = ["Axolotl", "Lion", "Heron", "Badger", "Lynx", "Otter", "Mole", "Ibis", "Gecko", "Marten", "Kestrel", "Tapir"];
const GAMES = ["Block Puzzle", "Hold'em", "Trading Duel"];
const ENTRIES = [100, 500, 1000];

const OWN: Omit<OwnPosition, "id" | "n" | "debtStart" | "unlockAt">[] = [
  { chain: "SOL", principal: 2, apy: 0.071, state: "repaying", debt: 0.0612, ownGemas: 1800 },
  { chain: "ETH", principal: 0.5, apy: 0.031, state: "repaying", debt: 0.0093, ownGemas: 0 },
  { chain: "SOL", principal: 5, apy: 0.071, state: "paid", debt: 0, ownGemas: 0 },
  { chain: "HYPE", principal: 40, apy: 0.052, state: "repaying", debt: 1.31, ownGemas: 650 },
  { chain: "SOL", principal: 1, apy: 0.071, state: "repaying", debt: 0.0521, ownGemas: 0 },
  { chain: "ETH", principal: 0.2, apy: 0.031, state: "paid", debt: 0, ownGemas: 0 },
  { chain: "ETH", principal: 1, apy: 0.031, state: "repaying", debt: 0.0041, ownGemas: 300 },
  { chain: "HYPE", principal: 100, apy: 0.052, state: "repaying", debt: 4.9, ownGemas: 0 },
  { chain: "SOL", principal: 0.5, apy: 0.071, state: "repaying", debt: 0.0024, ownGemas: 0 },
];
const UNLOCK_DAYS = [118, 214, 0, 151, 330, 0, 61, 362, 9];

export function makeFixture(size: Size, now: number): Fixture {
  const r = rng(17);
  const { sources: nSrc, positions: nPos } = COUNTS[size];
  const positions: OwnPosition[] = OWN.slice(0, nPos).map((p, i) => {
    const unlockAt = now + UNLOCK_DAYS[i] * DAY;
    return { ...p, id: `pos-${i}`, n: 0, debtStart: p.debt * 1.6 || p.principal * p.apy, unlockAt };
  });
  const perChain: Record<Chain, number> = { SOL: 0, ETH: 0, HYPE: 0 };
  for (const p of positions) p.n = ++perChain[p.chain];

  const sources: Source[] = [];
  for (let i = 0; i < nSrc; i++) {
    const x = r();
    const chain: Chain = x < 0.55 ? "SOL" : x < 0.82 ? "ETH" : "HYPE";
    const roll = r();
    const origin: Origin = roll < 0.86 ? "match" : roll < 0.95 ? "season" : "backing";
    const entry = ENTRIES[Math.floor(r() * ENTRIES.length)];
    const gemas =
      origin === "season" ? Math.round(200 + r() * 2400) : origin === "backing" ? Math.round(80 + r() * 600) : Math.round(entry * (0.92 + r() * 0.06));
    const wonAt = now - Math.round(r() * 120) * DAY - Math.round(r() * DAY);
    // Each Source's Position repays on its own clock: some landed long ago, most land over the coming months.
    const span = (30 + r() * 330) * DAY;
    const readyAt = r() < 0.18 ? now - Math.round(r() * 20) * DAY : wonAt + span;
    const share = readyAt <= now ? 1 : Math.max(0, Math.min(1, (now - (readyAt - span)) / span));
    const owner = `${GEMS[Math.floor(r() * GEMS.length)]} ${ANIMALS[Math.floor(r() * ANIMALS.length)]}`;
    const from =
      origin === "match" ? `${GAMES[Math.floor(r() * GAMES.length)]} · ${entry.toLocaleString("en-US")}` : origin === "season" ? `Season ${2 + Math.floor(r() * 4)} payout` : "Backing won";
    sources.push({ id: `src-${i}`, chain, owner, origin, from, wonAt, gemas, redeemable: Math.floor(gemas * share), readyAt });
  }
  sources.sort((a, b) => b.wonAt - a.wonAt);
  return { now, positions, sources };
}

/* ——— roll-ups the variants share ——— */

export const pendingOf = (s: Source) => s.gemas - s.redeemable;
export const gemasToAsset = (gemas: number, chain: Chain) => (gemas * GEMA_USD) / USD[chain];
export const assetToGemas = (amount: number, chain: Chain) => Math.round((amount * USD[chain]) / GEMA_USD);
/** Instant Redeem pays 75% of the Gemas' value now. */
export const INSTANT = 0.75;

export interface ChainSum {
  chain: Chain;
  sources: number;
  gemas: number;
  redeemable: number;
  pending: number;
  ownGemas: number;
  positions: OwnPosition[];
  lastReady: number | null;
}

export function byChain(f: Fixture): ChainSum[] {
  return CHAINS.map((chain) => {
    const src = f.sources.filter((s) => s.chain === chain);
    const positions = f.positions.filter((p) => p.chain === chain);
    const pend = src.filter((s) => pendingOf(s) > 0);
    return {
      chain,
      sources: src.length,
      gemas: src.reduce((t, s) => t + s.gemas, 0),
      redeemable: src.reduce((t, s) => t + s.redeemable, 0),
      pending: src.reduce((t, s) => t + pendingOf(s), 0),
      ownGemas: positions.reduce((t, p) => t + p.ownGemas, 0),
      positions,
      lastReady: pend.length ? Math.max(...pend.map((s) => s.readyAt)) : null,
    };
  });
}

export function totals(f: Fixture) {
  const won = f.sources.reduce((t, s) => t + s.gemas, 0);
  const own = f.positions.reduce((t, p) => t + p.ownGemas, 0);
  const redeemable = f.sources.reduce((t, s) => t + s.redeemable, 0);
  return { total: won + own, won, own, redeemable, pending: won - redeemable };
}

export interface Bucket {
  key: string;
  label: string;
  end: number;
  gemas: Record<Chain, number>;
  sources: number;
  unlocks: OwnPosition[];
}

/** Pending Gemas by when their Source finishes repaying, plus the own Positions that unlock in each window. */
export function timeline(f: Fixture): Bucket[] {
  const n = f.now;
  const edges: [string, string, number][] = [
    ["week", "This week", n + 7 * DAY],
    ["month", "This month", n + 30 * DAY],
    ["3m", "In 1–3 months", n + 91 * DAY],
    ["6m", "In 3–6 months", n + 182 * DAY],
    ["12m", "In 6–12 months", n + 366 * DAY],
  ];
  const buckets: Bucket[] = edges.map(([key, label, end]) => ({ key, label, end, gemas: { SOL: 0, ETH: 0, HYPE: 0 }, sources: 0, unlocks: [] }));
  for (const s of f.sources) {
    const p = pendingOf(s);
    if (p <= 0) continue;
    const b = buckets.find((x) => s.readyAt <= x.end) ?? buckets[buckets.length - 1];
    b.gemas[s.chain] += p;
    b.sources++;
  }
  for (const p of f.positions) {
    if (p.state !== "repaying") continue;
    const b = buckets.find((x) => p.unlockAt <= x.end) ?? buckets[buckets.length - 1];
    b.unlocks.push(p);
  }
  return buckets;
}

/* ——— words ——— */

const DECIMALS: Record<Chain, number> = { SOL: 4, ETH: 5, HYPE: 2 };
export const fmtAmt = (n: number, chain: Chain) =>
  `${n.toLocaleString("en-US", { maximumFractionDigits: DECIMALS[chain], minimumFractionDigits: Math.min(2, DECIMALS[chain]) })} ${chain}`;
export const fmtG = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtUsd = (gemas: number) =>
  `$${(gemas * GEMA_USD).toLocaleString("en-US", { maximumFractionDigits: gemas * GEMA_USD < 100 ? 2 : 0, minimumFractionDigits: 0 })}`;
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function fmtIn(ms: number, now: number) {
  const d = Math.round((ms - now) / DAY);
  if (d <= 0) return "now";
  if (d === 1) return "tomorrow";
  if (d < 14) return `in ${d} days`;
  if (d < 60) return `in ${Math.round(d / 7)} weeks`;
  return `in ${Math.round(d / 30.4)} months`;
}

export function fmtAgo(ms: number, now: number) {
  const d = Math.floor((now - ms) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : `${Math.round(d / 30.4)} mo ago`;
}

export const posName = (p: OwnPosition) => `${p.chain} Position ${p.n}`;
