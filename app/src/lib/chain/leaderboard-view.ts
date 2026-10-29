import { PRIZE_PLACES, rankPayout } from "./season";

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
  winners: { rank: number; account: string; points: number; gemas: number; paid: boolean; voided: boolean }[];
  /** Unix seconds the payout window ends and ranks are paid; null for a Season recorded before the window. */
  payoutAt: number | null;
}

/** What the winners list says beside a rank's prize: nothing once paid. */
export function lastRankNote(w: { paid: boolean; voided: boolean }, payoutAt: number | null, nowSecs: number): { kind: "none" | "voided" | "paying"; payoutAt?: number } {
  const state = rankPayout(w, payoutAt, nowSecs);
  if (state === "paid") return { kind: "none" };
  if (state === "voided") return { kind: "voided" };
  return state === "waiting" ? { kind: "paying", payoutAt: payoutAt! } : { kind: "paying" };
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
  /** The Account asked for with `?me=`, wherever it ranks (also below the top it lists); null without points. */
  me?: LeaderboardRow | null;
}

/** Where an Account stands this season and what the next step up costs, in points. */
export interface SeasonStanding {
  /** null: no points this season. */
  rank: number | null;
  points: number;
  /** Points that pass the Player one rank up; null at 1st or without points. */
  toNext: number | null;
  /** Points that reach the paid ranks; 0 when already in them. */
  toPrizes: number;
}

export function seasonStanding(view: LeaderboardView, me: string): SeasonStanding {
  const i = view.standings.findIndex((r) => r.account === me);
  const row = view.me ?? view.standings[i] ?? null;
  if (!row) return { rank: null, points: 0, toNext: null, toPrizes: 0 };
  // Ranks are unique (ties go to the earlier first win), so one point more than a rank always passes it.
  const past = (r: LeaderboardRow | undefined) => (r ? r.points - row.points + 1 : null);
  if (row.rank > PRIZE_PLACES) return { rank: row.rank, points: row.points, toNext: null, toPrizes: past(view.standings[PRIZE_PLACES - 1]) ?? 0 };
  return { rank: row.rank, points: row.points, toNext: i > 0 ? past(view.standings[i - 1]) : null, toPrizes: 0 };
}

export const ordinal = (n: number) => {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"}`;
};
export const pts = (n: number) => `${n} ${n === 1 ? "pt" : "pts"}`;

/** The next step up, in one short line; none at 1st. */
export function nextStep(s: SeasonStanding) {
  if (s.rank === null) return null;
  if (s.toPrizes > 0) return `${pts(s.toPrizes)} to the prizes`;
  if (s.toNext === null) return null;
  return `${pts(s.toNext)} to ${ordinal(s.rank - 1)}`;
}

/**
 * Where you stand, for the Leaderboard hero and the Lobby teaser: "15 pts · 3rd · 20 pts to 2nd".
 * Without points: what a win is worth (`winPoints`, the smallest entry's), or, with fewer than ten Players ranked, that any win reaches the prizes.
 */
export function standingSummary(s: SeasonStanding, players: number, winPoints: number): string {
  if (s.rank === null) {
    return players < PRIZE_PLACES ? "No points yet · any win puts you in the prizes" : `No points yet · a win is +${winPoints}`;
  }
  return [pts(s.points), ordinal(s.rank), nextStep(s)].filter(Boolean).join(" · ");
}
