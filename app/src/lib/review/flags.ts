/**
 * Suspicious-play flags for the admin review page (ticket 32). Pure rules over public chain data:
 * a Season's wins (with the loser named) and, for Block Puzzle, each run's batch cadence.
 * Flags only point a human at an Account. Voiding stays a decision for the founders (ADR 0011).
 */
import type { Win } from "../chain/season";

/** Rollup (TEE) slots are about 50 ms; base-layer slots about 400 ms. Move offsets are rollup slots. */
export const ROLLUP_SLOT_MS = 50;

/** A person needs about 300 ms to look at a piece and place it: a median under this per move is too fast. */
export const HUMAN_FLOOR_SLOTS_PER_MOVE = 6;
/** Spread of the gaps between batches (stdev / mean). Human play measured well above 0.3; a script on a timer sits near 0. */
export const UNIFORM_CV = 0.08;
/** A run needs this many batches (so MIN_BATCHES - 1 gaps) before its cadence says anything. */
export const MIN_BATCHES = 8;
/** An Account is flagged for timing when this many of its runs look scripted. */
export const MIN_SCRIPTED_RUNS = 2;

/** Two Accounts with this many Matches against each other in a Season keep meeting (the Points cap stops at 3 wins each way). */
export const PAIR_MIN_MATCHES = 8;
/** One side holding this share of the pair's decided Matches makes it lopsided. */
export const PAIR_LOPSIDED_SHARE = 0.8;

/** Win rate flagged from this many decided Matches... */
export const RATE_MIN_MATCHES = 20;
/** ...at or above this share of them won. */
export const RATE_MIN_WIN_SHARE = 0.75;

export interface RunBatches {
  matchId: string;
  /** TesoroAccount that played the run. */
  account: string;
  batches: { slots: number; moves: number }[];
}

export type FlagKind = "timing" | "pair" | "win-rate";

export interface Flag {
  kind: FlagKind;
  season: number;
  /** TesoroAccount the flag is about. */
  account: string;
  /** Plain-words reason. */
  summary: string;
  /** Matches that back the flag (ids), most recent last. */
  matchIds: string[];
  /** The other Account, for pair flags. */
  other?: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface RunPace {
  /** Median slots per move across the run. */
  medianSlotsPerMove: number;
  /** Stdev / mean of the gaps between batches. */
  gapCv: number;
  tooFast: boolean;
  tooUniform: boolean;
}

/** The cadence of one run, or null when it has too few batches to judge. */
export function runPace(batches: { slots: number; moves: number }[]): RunPace | null {
  if (batches.length < MIN_BATCHES) return null;
  const gaps: number[] = [];
  const perMove: number[] = [];
  for (let i = 1; i < batches.length; i++) {
    const gap = batches[i].slots - batches[i - 1].slots;
    if (gap < 0) continue;
    gaps.push(gap);
    perMove.push(gap / Math.max(1, batches[i].moves));
  }
  if (gaps.length < MIN_BATCHES - 1) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const gapCv = mean > 0 ? sd / mean : 0;
  const medianSlotsPerMove = median(perMove);
  return { medianSlotsPerMove, gapCv, tooFast: medianSlotsPerMove < HUMAN_FLOOR_SLOTS_PER_MOVE, tooUniform: gapCv < UNIFORM_CV };
}

/** Accounts with at least MIN_SCRIPTED_RUNS runs that are too fast or too uniform. */
export function timingFlags(season: number, runs: RunBatches[]): Flag[] {
  const by = new Map<string, { id: string; fast: boolean; uniform: boolean }[]>();
  for (const r of runs) {
    const pace = runPace(r.batches);
    if (!pace || (!pace.tooFast && !pace.tooUniform)) continue;
    const list = by.get(r.account) ?? [];
    list.push({ id: r.matchId, fast: pace.tooFast, uniform: pace.tooUniform });
    by.set(r.account, list);
  }
  const out: Flag[] = [];
  for (const [account, list] of by) {
    if (list.length < MIN_SCRIPTED_RUNS) continue;
    const fast = list.filter((x) => x.fast).length;
    const uniform = list.filter((x) => x.uniform).length;
    const parts = [fast && `${fast} too fast for a person (under ${HUMAN_FLOOR_SLOTS_PER_MOVE * ROLLUP_SLOT_MS} ms a move)`, uniform && `${uniform} with near-identical gaps between moves`].filter(Boolean);
    out.push({ kind: "timing", season, account, summary: `${list.length} Block Puzzle runs look scripted: ${parts.join(", ")}.`, matchIds: list.map((x) => x.id) });
  }
  return out.sort((a, b) => b.matchIds.length - a.matchIds.length || (a.account < b.account ? -1 : 1));
}

/** Pairs that met PAIR_MIN_MATCHES times or more in the Season. Flagged once, on the side that won more. */
export function pairFlags(season: number, wins: Win[]): Flag[] {
  const pairs = new Map<string, { a: string; b: string; aWins: string[]; bWins: string[] }>();
  for (const w of wins) {
    if (!w.loser) continue;
    const [a, b] = w.player < w.loser ? [w.player, w.loser] : [w.loser, w.player];
    const key = `${a}|${b}`;
    const p = pairs.get(key) ?? { a, b, aWins: [], bWins: [] };
    (w.player === a ? p.aWins : p.bWins).push(w.matchId);
    pairs.set(key, p);
  }
  const out: Flag[] = [];
  for (const p of pairs.values()) {
    const total = p.aWins.length + p.bWins.length;
    if (total < PAIR_MIN_MATCHES) continue;
    const [top, low, topWins, lowWins] = p.aWins.length >= p.bWins.length ? [p.a, p.b, p.aWins, p.bWins] : [p.b, p.a, p.bWins, p.aWins];
    const lopsided = topWins.length / total >= PAIR_LOPSIDED_SHARE;
    out.push({
      kind: "pair",
      season,
      account: top,
      other: low,
      summary: `Met ${total} times this Season: ${topWins.length} won by this Account, ${lowWins.length} by the other${lopsided ? ". Lopsided" : ""}.`,
      matchIds: [...topWins, ...lowWins],
    });
  }
  return out.sort((a, b) => b.matchIds.length - a.matchIds.length || (a.account < b.account ? -1 : 1));
}

/** Accounts that won RATE_MIN_WIN_SHARE or more of at least RATE_MIN_MATCHES decided Matches (losses known only from wins naming the loser). */
export function winRateFlags(season: number, wins: Win[]): Flag[] {
  const rec = new Map<string, { won: string[]; lost: number }>();
  const get = (k: string) => rec.get(k) ?? (rec.set(k, { won: [], lost: 0 }), rec.get(k)!);
  for (const w of wins) {
    get(w.player).won.push(w.matchId);
    if (w.loser) get(w.loser).lost++;
  }
  const out: Flag[] = [];
  for (const [account, r] of rec) {
    const total = r.won.length + r.lost;
    if (total < RATE_MIN_MATCHES || r.won.length / total < RATE_MIN_WIN_SHARE) continue;
    out.push({ kind: "win-rate", season, account, summary: `Won ${r.won.length} of ${total} decided Matches (${Math.round((100 * r.won.length) / total)}%).`, matchIds: r.won });
  }
  return out.sort((a, b) => b.matchIds.length - a.matchIds.length || (a.account < b.account ? -1 : 1));
}

export interface SeasonInput {
  season: number;
  wins: Win[];
  runs: RunBatches[];
}

/** Every flag for the given Seasons, newest Season first, then pair, timing, win rate. */
export function reviewFlags(seasons: SeasonInput[]): Flag[] {
  return [...seasons]
    .sort((a, b) => b.season - a.season)
    .flatMap((s) => [...timingFlags(s.season, s.runs), ...pairFlags(s.season, s.wins), ...winRateFlags(s.season, s.wins)]);
}

export interface ReviewSeason {
  number: number;
  /** "current", or "payout-window" for the Season that ended less than 48 hours ago. */
  phase: "current" | "payout-window";
  windowEnds?: number;
}

export interface ReviewReply {
  now: number;
  seasons: ReviewSeason[];
  flags: Flag[];
}

