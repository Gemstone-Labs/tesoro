import type { Decorator } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import type { LeaderboardView } from "@/lib/chain/leaderboard-view";
import type { DuelView } from "@/games/trading-duel/useDuelMatch";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import type { ArmyAccount, Battle } from "@/games/vanguard/decode";
import type { VanguardView } from "@/games/vanguard/useVanguardMatch";
import type { RunStage } from "@/lib/chain/match-flow";
import { DEMO_ME } from "../../support/data";
import type { GameId } from "@/lib/mock";

/** What the screen-level mocks (leaderboard, queue depth, Backing board, EVM market) return for the current story. */
export interface ScreenData {
  /** Leaderboard page: a live season, the pool not open yet, a season waiting to be paid, still loading, or failed. */
  leaderboard?: "live" | "deep" | "empty" | "upgrade" | "settling" | "paying" | "carried" | "outside" | "loading" | "error";
  /** Backing page: still loading, or the read failed. Default: the demo board. */
  board?: "loading" | "error";
  /** Leaderboard Pool in the top bar: its Gemas (null hides it), and a Match fee landing every `growMs`. */
  pool?: { gemas: number | null; growMs?: number };
  /** Open Queue Matches per Game. */
  queueDepth?: Record<GameId, number>;
  /** The signed-in Player is on a Break or Self-Excluded (pages that offer entries show the notice instead). */
  away?: "break" | "self-exclusion";
  /** Entering through the Queue finds a Match the Player still has to play (nothing new is entered). */
  entered?: "existing";
  /** The 18+ confirmation is still owed: the entry asks for it. Default: already confirmed. */
  age?: "ask";
  /** The Backing Request to open in the Offer drawer (the URL hash). */
  hash?: string;
  /** The URL query (without "?") the page reads from `window.location.search`, e.g. "open=1&game=holdem&need=2500". */
  search?: string;
  /** Block Burst Match: where the signed-in Player's run is, whether the joiner timed out, and the setup step shown while preparing. */
  run?: { stage: RunStage; timeout?: boolean; step?: string; settleError?: string };
  /** Ethereum / HyperEVM Positions: the Advance on every Position card, and how far an opening Position has got. */
  eth?: { advance?: "open" | "paid"; opening?: "sent" | "delivered" | "recorded" | "arrived" | "failed" };
  /** The bridge's mirror of the EVM vaults' treasuries (Redeem now on ETH and HYPE): enough to pay, nearly empty, or no mirror (old vault). Default: ready. */
  vaultTreasury?: "ready" | "short" | "none";
  /** Hold'em Match: what the driver reports (merged over a "waiting" view). */
  holdem?: Partial<HoldemView>;
  /** Vanguard Match: what the driver reports (merged over a "waiting" view); `later` swaps in a newer Battle after a delay, as the rollup would. */
  vanguard?: Partial<VanguardView> & { later?: { afterMs: number; battle: Battle; army?: ArmyAccount }; refuse?: string };
  /** Trading Duel Match: what the driver reports (merged over a "waiting" view). */
  duel?: Partial<DuelView>;
}

let current: ScreenData = {};
export const screenData = () => current;
export const setScreenData = (d: ScreenData) => {
  current = d;
};

let addedParams: string[] = [];

/** Reads `parameters.screen` before each story renders. Add it to a story file's `decorators`. */
export const withScreen: Decorator = (Story, ctx) => {
  current = (ctx.parameters.screen ?? {}) as ScreenData;
  if (typeof window !== "undefined") {
    const hash = current.hash ? `#${current.hash}` : "";
    // Add the story's params beside Storybook's own (`id`, `viewMode`), and drop the ones the last story added.
    const params = new URLSearchParams(window.location.search);
    for (const k of addedParams) params.delete(k);
    const extra = new URLSearchParams(current.search ?? "");
    addedParams = [...extra.keys()];
    extra.forEach((v, k) => params.set(k, v));
    const search = params.size ? `?${params}` : "";
    if (window.location.hash !== hash || window.location.search !== search) history.replaceState(null, "", `${window.location.pathname}${search}${hash}`);
  }
  return Story();
};

export const demoKey = (n: number) => PublicKey.findProgramAddressSync([Buffer.from(`demo-${n}`)], PublicKey.default)[0].toBase58();

const now = () => Math.floor(Date.now() / 1000);

/** A season table in the shape `/api/leaderboard` returns: the top 50 of 61 Players. The demo Account is third, or 23rd with "deep". */
export function leaderboardView(kind: "live" | "deep" | "empty" | "upgrade" | "settling" | "paying" | "carried" | "outside"): LeaderboardView {
  const SEASON = 7 * 24 * 3600;
  const start = now() - 2 * 24 * 3600;
  const base = { now: now(), season: { number: 4, start, end: start + SEASON } };
  const mine = kind === "deep" ? 22 : kind === "outside" ? -1 : 2;
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
  if (kind === "paying") {
    const waiting = { ...last, payoutAt: now() + 30 * 3600, winners: last.winners.map((w, i) => ({ ...w, paid: false, voided: i === 3 })) };
    return { ...base, poolGemas: 12_650, feeBps: 100, standings, players: 61, last: waiting, settling: null };
  }
  if (kind === "carried") return { ...base, poolGemas: 12_650, feeBps: 100, standings, players: 61, last: { ...last, winners: [] }, settling: null };
  return { ...base, poolGemas: 12_650, feeBps: 100, standings, players: 61, last, settling: null };
}
