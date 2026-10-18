import type { Decorator } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import type { LeaderboardView } from "@/lib/chain/leaderboard-view";
import type { DuelView } from "@/games/trading-duel/useDuelMatch";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import type { Battle } from "@/games/vanguard/decode";
import type { VanguardView } from "@/games/vanguard/useVanguardMatch";
import type { RunStage } from "@/lib/chain/match-flow";
import { DEMO_ME } from "../../support/data";
import type { GameId } from "@/lib/mock";

/** What the screen-level mocks (leaderboard, queue depth, Backing board, EVM market) return for the current story. */
export interface ScreenData {
  /** Leaderboard page: a live season, the pool not open yet, a season waiting to be paid, still loading, or failed. */
  leaderboard?: "live" | "deep" | "empty" | "upgrade" | "settling" | "loading" | "error";
  /** Backing page: still loading, or the read failed. Default: the demo board. */
  board?: "loading" | "error";
  /** Leaderboard Pool in the top bar: its Gemas (null hides it), and a Match fee landing every `growMs`. */
  pool?: { gemas: number | null; growMs?: number };
  /** Open Queue Matches per Game. */
  queueDepth?: Record<GameId, number>;
  /** The Backing Request to open in the Offer drawer (the URL hash). */
  hash?: string;
  /** Block Puzzle Match: where the signed-in Player's run is, whether the joiner timed out, and the setup step shown while preparing. */
  run?: { stage: RunStage; timeout?: boolean; step?: string };
  /** Ethereum / HyperEVM Positions: the Advance on every Position card, and how far an opening Position has got. */
  eth?: { advance?: "open" | "paid"; opening?: "sent" | "delivered" | "recorded" | "arrived" | "failed" };
  /** The bridge's mirror of the EVM vaults' treasuries (Redeem now on ETH and HYPE): enough to pay, nearly empty, or no mirror (old vault). Default: ready. */
  vaultTreasury?: "ready" | "short" | "none";
  /** Hold'em Match: what the driver reports (merged over a "waiting" view). */
  holdem?: Partial<HoldemView>;
  /** Vanguard Match: what the driver reports (merged over a "waiting" view); `later` swaps in a newer Battle after a delay, as the rollup would. */
  vanguard?: Partial<VanguardView> & { later?: { afterMs: number; battle: Battle }; refuse?: string };
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

/** A season table in the shape `/api/leaderboard` returns: the top 50 of 61 Players. The demo Account is third, or 23rd with "deep". */
export function leaderboardView(kind: "live" | "deep" | "empty" | "upgrade" | "settling"): LeaderboardView {
  const SEASON = 7 * 24 * 3600;
  const start = now() - 2 * 24 * 3600;
  const base = { now: now(), season: { number: 4, start, end: start + SEASON } };
  const mine = kind === "deep" ? 22 : 2;
  const keys = Array.from({ length: 50 }, (_, i) => (i === mine ? DEMO_ME : i === 1 ? demoKey(2) : demoKey(801 + i)));
  const standings = keys.map((account, i) => {
    const points = Math.round(420 * 0.94 ** i);
    return { rank: i + 1, account, points, wins: Math.max(1, Math.round(points / 11)) };
  });
  const last = {
    number: 3,
    poolGemas: 18_400,
    winners: standings.slice(0, 10).map((s, i) => ({ rank: i + 1, account: s.account, points: 400 - i * 28, gemas: Math.floor((18_400 * [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400][i]) / 10_000), paid: true, voided: false })),
    payoutAt: null,
  };
  if (kind === "empty") return { ...base, poolGemas: 0, feeBps: 100, standings: [], players: 0, last: null, settling: null };
  if (kind === "upgrade") return { ...base, poolGemas: 0, feeBps: 0, standings: [], players: 0, last: null, settling: null };
  // A settling season has no record yet, so the server sends no last season with it.
  if (kind === "settling") return { ...base, poolGemas: 12_650, feeBps: 100, standings, players: 61, last: null, settling: 3 };
  return { ...base, poolGemas: 12_650, feeBps: 100, standings, players: 61, last, settling: null };
}
