/** What `/api/leaderboard` returns and the page draws. Plain JSON: Gemas are numbers, times are unix seconds. */
export interface LeaderboardRow {
  rank: number;
  /** Account key. */
  account: string;
  points: number;
  wins: number;
}

export interface LastSeason {
  number: number;
  poolGemas: number;
  winners: { rank: number; account: string; points: number; gemas: number; paid: boolean }[];
}

export interface LeaderboardView {
  /** Server time, unix seconds. */
  now: number;
  season: { number: number; start: number; end: number };
  /** Gemas in the pool now: this season's prize money plus any roll-over. */
  poolGemas: number;
  /** Leaderboard Fee in basis points of the Pot, as the program charges it (0 while off). */
  feeBps: number;
  /** Top of this season's table. */
  standings: LeaderboardRow[];
  /** Total Players with points this season. */
  players: number;
  /** The season before this one, once it has been recorded and paid out. */
  last: LastSeason | null;
  /** The season before this one has ended but is not recorded yet. */
  settling: number | null;
}
