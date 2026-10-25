import { HISTORY_PAGE, type HistoryRow } from "@/lib/chain/history";
import { HIDDEN_GAMES } from "@/lib/games";
import type { Win } from "@/lib/chain/season";
import { matchKeyOf, type MatchKey } from "./match-key";
import type { Rpc } from "./rpc";

/** Banners per page: the same as the pages the app cuts from the full history. */
export const HISTORY_PAGE_SIZE = HISTORY_PAGE;

/** One page of an Account's finished Matches, played and funded, newest first (page 1-based, clamped), optionally of one Game id. */
export async function accountHistory(rpc: Rpc, account: string, page = 1, size = HISTORY_PAGE_SIZE, game: string | null = null) {
  return (await rpc("history_page", { p_account: account, p_page: page, p_size: size, p_game: game })) as { rows: HistoryRow[]; page: number; pages: number; total: number };
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
  /** Block Burst only: [winner score, loser score]. */
  scores: [number, number] | null;
  at: number;
}

const VISIBLE_PAGE = 200;
const VISIBLE_MAX_PAGES = 10;

/**
 * `accountHistory` with the Games this environment hides taken out of the rows, the total and the page count.
 * A request for one visible Game passes straight through; otherwise it reads up to 2,000 of the newest rows and cuts the page itself.
 */
export async function visibleAccountHistory(rpc: Rpc, account: string, page: number, size: number, game: string | null, hidden: ReadonlySet<string> = HIDDEN_GAMES) {
  if (hidden.size === 0 || game) return accountHistory(rpc, account, page, size, game);
  const first = await accountHistory(rpc, account, 1, VISIBLE_PAGE, null);
  const rest = await Promise.all(Array.from({ length: Math.max(0, Math.min(first.pages, VISIBLE_MAX_PAGES) - 1) }, (_, i) => accountHistory(rpc, account, i + 2, VISIBLE_PAGE, null)));
  const rows = [first, ...rest].flatMap((r) => r.rows).filter((r) => !hidden.has(r.game));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((at - 1) * size, at * size), page: at, pages, total: rows.length };
}

/** `recentWins` without the Games this environment hides. */
export async function visibleRecentWins(rpc: Rpc, q: { game?: string; since?: number; limit: number }, hidden: ReadonlySet<string> = HIDDEN_GAMES): Promise<RecentWin[]> {
  if (hidden.size === 0) return recentWins(rpc, q);
  return (await recentWins(rpc, { ...q, limit: 200 })).filter((w) => !hidden.has(w.game)).slice(0, q.limit);
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
