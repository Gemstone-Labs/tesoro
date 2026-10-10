import type { Decorator } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import type { LeaderboardView } from "@/lib/chain/leaderboard-view";
import type { DuelView } from "@/games/trading-duel/useDuelMatch";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import type { RunStage } from "@/lib/chain/match-flow";
import { DEMO_ME } from "../../support/data";

/** What the screen-level mocks (leaderboard, queue depth, Backing board, EVM market) return for the current story. */
export interface ScreenData {
  /** Leaderboard page: a live season, the pool not open yet, a season waiting to be paid, still loading, or failed. */
  leaderboard?: "live" | "empty" | "upgrade" | "settling" | "loading" | "error";
  /** Backing page: still loading, or the read failed. Default: the demo board. */
  board?: "loading" | "error";
  /** Open Queue Matches per Game. */
  queueDepth?: { "block-puzzle": number; holdem: number; "trading-duel": number };
  /** The Backing Request to open in the Offer drawer (the URL hash). */
  hash?: string;
  /** Block Puzzle Match: where the signed-in Player's run is, whether the joiner timed out, and the setup step shown while preparing. */
  run?: { stage: RunStage; timeout?: boolean; step?: string };
  /** Ethereum / HyperEVM Positions: the Advance on every Position card, and how far an opening Position has got. */
  eth?: { advance?: "open" | "paid"; opening?: "sent" | "delivered" | "recorded" | "arrived" | "failed" };
  /** Hold'em Match: what the driver reports (merged over a "waiting" view). */
  holdem?: Partial<HoldemView>;
  /** Trading Duel Match: what the driver reports (merged over a "waiting" view). */
  duel?: Partial<DuelView>;
}

let current: ScreenData = {};
export const screenData = () => current;
export const setScreenData = (d: ScreenData) => {
  current = d;
};

/** Reads `parameters.screen` before each story renders. Add it to a story file's `decorators`. */
export const withScreen: Decorator = (Story, ctx) => {
  current = (ctx.parameters.screen ?? {}) as ScreenData;
  if (typeof window !== "undefined") {
    const hash = current.hash ? `#${current.hash}` : "";
    if (window.location.hash !== hash) history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }
  return Story();
};

export const demoKey = (n: number) => PublicKey.findProgramAddressSync([Buffer.from(`demo-${n}`)], PublicKey.default)[0].toBase58();

const now = () => Math.floor(Date.now() / 1000);

/** A season table in the shape `/api/leaderboard` returns. The demo Account is third. */
export function leaderboardView(kind: "live" | "empty" | "upgrade" | "settling"): LeaderboardView {
  const SEASON = 7 * 24 * 3600;
  const start = now() - 2 * 24 * 3600;
  const base = { now: now(), season: { number: 4, start, end: start + SEASON } };
  const keys = [801, 2, DEMO_ME, 803, 804, 805, 806, 807, 808, 809, 810, 811].map((k) => (typeof k === "number" ? demoKey(k) : k));
  const standings = keys.map((account, i) => ({ rank: i + 1, account, points: 420 - i * 31, wins: 38 - i * 3 }));
  const last = {
    number: 3,
    poolGemas: 18_400,
    winners: standings.slice(0, 10).map((s, i) => ({ rank: i + 1, account: s.account, points: 400 - i * 28, gemas: Math.floor((18_400 * [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400][i]) / 10_000), paid: true })),
  };
  if (kind === "empty") return { ...base, poolGemas: 0, feeBps: 100, standings: [], players: 0, last: null, settling: null };
  if (kind === "upgrade") return { ...base, poolGemas: 0, feeBps: 0, standings: [], players: 0, last: null, settling: null };
  return { ...base, poolGemas: 12_650, feeBps: 100, standings, players: 61, last, settling: kind === "settling" ? 3 : null };
}
