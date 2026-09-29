/**
 * Types are named after CONTEXT.md terms so real data can replace the mock
 * without renaming anything in the UI.
 */

export type Chain = "SOL" | "ETH" | "HYPE";
/** Each Position's asset is the native asset of its chain. */
export type Asset = Chain;
export type GameId = "block-puzzle" | "holdem";
export type EntrySize = 500 | 1000 | 2500;

export interface Account {
  id: string;
  displayName: string;
  addresses: { solana: string; evm: string };
}

export interface Advance {
  id: string;
  positionId: string;
  horizonMonths: number;
  gemasIssued: number;
  /** Projected yield over the Horizon, in the Position's asset. */
  projectedYield: number;
  issuedAt: string;
  unlockEstimate: string;
}

export interface Position {
  id: string;
  chain: Chain;
  asset: Asset;
  /** Locked, never played with, never pays Debt. In asset units. */
  principal: number;
  /** Provider's projected annual yield, as a fraction (0.07 = 7%). */
  apy: number;
  /** At most one open Advance. */
  advance: Advance | null;
  /** Outstanding Gemas Sourced from this Position, in the Position's asset. */
  debt: number;
}

export interface Source {
  positionId: string;
  chain: Chain;
  asset: Asset;
  /** Whose Position this Source is. */
  owner: string;
  advanceId: string;
}

/** Gemas held by the Account, grouped by the Source they were issued from. */
export interface GemaHolding {
  source: Source;
  gemas: number;
  /** Share of this Source's yield that has actually accrued (0..1). */
  accruedShare: number;
  /** True when the Source is the Account's own Position. */
  own: boolean;
}

export type MatchResult = "won" | "lost" | "draw" | "refunded";

export interface Match {
  id: string;
  game: GameId;
  entry: EntrySize;
  opponent: string;
  result: MatchResult;
  /** Gemas gained (+) or lost (-) at settlement, after Fees. */
  gemasDelta: number;
  seed: string;
  playedAt: string;
  backed: boolean;
}

export interface PlayerRecord {
  id: string;
  name: string;
  matches: number;
  /** Share of Matches won (0..1). */
  winRate: number;
}

export interface Request {
  id: string;
  player: PlayerRecord;
  game: GameId;
  entry: EntrySize;
  postedAt: string;
}

export interface Offer {
  id: string;
  backer: string;
  game: GameId;
  entry: EntrySize;
  /** Player's share of the surplus, in percent. */
  playerShare: number;
  /** Set when the Offer answers a Request; otherwise it is public. */
  requestId: string | null;
  applicants: PlayerRecord[];
}
