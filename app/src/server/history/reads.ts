import type { HistoryRow } from "@/lib/chain/history";
import type { Win } from "@/lib/chain/season";
import { matchKeyOf, type MatchKey } from "./match-key";
import type { Rpc } from "./rpc";

export const HISTORY_PAGE_SIZE = 20;

/** One page of an Account's finished Matches, played and funded, newest first (page 1-based, clamped). */
export async function accountHistory(rpc: Rpc, account: string, page = 1, size = HISTORY_PAGE_SIZE) {
  return (await rpc("history_page", { p_account: account, p_page: page, p_size: size })) as { rows: HistoryRow[]; page: number; pages: number; total: number };
}

export interface MatchPage {
  id: string;
  game: string;
  entry: number;
  status: "seen" | "settling" | "refunding" | "settled" | "refunded";
  kind: number | null;
  challenge: boolean;
  asset: number;
  openedAt: number;
  settledAt: number | null;
  sides: [{ player: string; funder: string }, { player: string; funder: string } | null];
  winnerSide: 0 | 1 | null;
  winner: string | null;
  loser: string | null;
  points: number | null;
  season: number | null;
  fees: { platform: number; studio: number; leaderboard: number };
  chunks: number;
  scores: [number, number] | null;
  parties: { account: string; role: "player" | "backer"; side: 0 | 1; result: string; delta: number; backingOther: string | null; shareBps: number | null }[];
}

/** The Match page of a Match whose run has started, or null while it is unknown to the history. */
export async function matchPage(rpc: Rpc, id: MatchKey): Promise<MatchPage | null> {
  return (await rpc("match_record", { p_opener: id.opener, p_n: id.n.toString() })) as MatchPage | null;
}

export interface WinCard {
  id: string;
  game: string;
  entry: number;
  /** TesoroAccount of the winning Player. */
  winner: string;
  /** Gemas the winner gained, net of Fees; 0 when a Backing share leaves the Player nothing. */
  gemas: number;
}

/** The card of a settled Match with a winner, or null for any other Match. */
export async function winCard(rpc: Rpc, id: MatchKey): Promise<WinCard | null> {
  return (await rpc("win_card", { p_opener: id.opener, p_n: id.n.toString() })) as WinCard | null;
}

export interface RecentWin {
  id: string;
  game: string;
  entry: number;
  winner: string;
  /** Gemas the winning side received: the Pot minus Fees. */
  payout: number;
  /** Block Puzzle only: [winner score, loser score]. */
  scores: [number, number] | null;
  at: number;
}

/** The newest settled Matches with a winner, optionally of one game and created at or after `since` (ms). */
export async function recentWins(rpc: Rpc, q: { game?: string; since?: number; limit: number }): Promise<RecentWin[]> {
  return (await rpc("recent_wins", { p_game: q.game ?? null, p_since: q.since ?? null, p_limit: q.limit })) as RecentWin[];
}

export interface PlayerForm {
  matches: number;
  wins: number;
  /** The Player's Gema change in each Match with a winner, oldest first. */
  pnl: number[];
}

/** Each Player's real record for the Backing board; a Player with no finished Match is absent. */
export async function playerForms(rpc: Rpc, players: string[]): Promise<Map<string, PlayerForm>> {
  if (!players.length) return new Map();
  const forms = (await rpc("player_forms", { p_accounts: players })) as Record<string, PlayerForm>;
  return new Map(Object.entries(forms));
}

/** A Season's wins for the Leaderboard, oldest first (the same shape the chain scan produced). */
export async function seasonWins(rpc: Rpc, season: number): Promise<Win[]> {
  return (await rpc("season_wins", { p_season: season })) as Win[];
}

export { matchKeyOf };
