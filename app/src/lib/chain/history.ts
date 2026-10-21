import { fmtGemas } from "../format";
import type { GameId, MatchResult } from "../mock/types";
import { backerDelta, matchDelta, seatResult } from "./ledger";
import { assetIndexOf, matchOpenedAt } from "./match-id";
import type { ChainMatch } from "./read";

/** One finished Match in an Account's history, as a Player or as the Backer who funded it. */
export interface HistoryRow {
  id: string;
  game: GameId;
  entry: number;
  role: "player" | "backer";
  /** From the result, never from `delta`: a backed Player's loss moves 0 Gemas and is still a loss. */
  result: MatchResult;
  /** Gemas this Account gained (+) or lost (−) at settlement, after Fees. A backed Player never goes below 0. */
  delta: number;
  /** The other party of a Backing: the Backer when this Account played backed, the Player when it backed. */
  backing: { other: string; shareBps: number } | null;
  /** Block Puzzle only: [this side's score, the opponent's]. */
  scores: [number, number] | null;
  /** TesoroAccount key of whoever played against this side, when anyone did. */
  opp: string | null;
  /** Milliseconds since the epoch (Match ids embed their creation time). */
  at: number;
  /** Trading Duel only: the asset index the Match traded (0 SOL, 1 ETH, 2 HYPE), from its id. */
  asset: number | null;
}

/** The history row of a finished Match, or null while it is unfinished or its result is not read yet. */
export function historyRow(m: ChainMatch): HistoryRow | null {
  if (m.status !== "settled" && m.status !== "refunded") return null;
  const role = m.seat !== null ? "player" : m.backing && m.backerSeat !== null ? "backer" : null;
  if (!role) return null;
  const seat = m.seat ?? (m.backing as NonNullable<ChainMatch["backing"]>).seat;
  const draw = !!m.session?.settled && m.session.result === "draw";
  const result = draw ? "draw" : m.status === "refunded" ? "refunded" : seatResult(m, seat);
  // A settled Match whose Session or Hold'em table could not be read has no known result: never a refund.
  if (!result) return null;
  const delta =
    result === "draw" || result === "refunded"
      ? 0
      : role === "player"
        ? matchDelta(m)
        : backerDelta({ ...m, backerSeat: seat, shareBps: m.backing?.shareBps ?? 0 });
  const backing = m.backing ? { other: role === "player" ? m.backing.funder : m.backing.player, shareBps: m.backing.shareBps } : null;
  const s = m.session;
  return {
    id: m.id.toString(),
    game: m.game,
    entry: m.entry,
    role,
    result,
    delta,
    backing,
    scores: s && s.settled ? (seat === 0 ? s.scores : [s.scores[1], s.scores[0]]) : null,
    opp: m.sides[1 - seat]?.player ?? null,
    at: matchOpenedAt(m.id, m.game),
    asset: m.game === "trading-duel" ? assetIndexOf(m.id) : null,
  };
}

/** Every finished Match of an Account (played and funded), newest first. */
export function accountHistory(played: ChainMatch[], funded: ChainMatch[] = []): HistoryRow[] {
  return [...played, ...funded]
    .map(historyRow)
    .filter((r): r is HistoryRow => r !== null)
    .sort((a, b) => b.at - a.at);
}

/** Every result a finished Match can have, in the order the filter shows them. */
export const RESULTS: readonly MatchResult[] = ["won", "lost", "draw", "refunded"];
/** What a Match history shows by default: Matches that were played. Refunds stay hidden until asked for. */
export const PLAYED: readonly MatchResult[] = ["won", "lost", "draw"];

/** The results a `?result=` value shows: the played ones when it is absent or unreadable, none for "none". */
export function resultFilter(v: string | null): MatchResult[] {
  if (v === null) return [...PLAYED];
  if (v === "none") return [];
  const asked = v.split(",");
  const shown = RESULTS.filter((r) => asked.includes(r));
  return shown.length > 0 ? shown : [...PLAYED];
}

/** The `?result=` value for a set of results: null for the default, "none" for none. */
export function resultParam(results: readonly MatchResult[]): string | null {
  const shown = RESULTS.filter((r) => results.includes(r));
  if (shown.join() === PLAYED.join()) return null;
  return shown.length > 0 ? shown.join(",") : "none";
}

/** The set with one result switched on or off. */
export function toggleResult(results: readonly MatchResult[], r: MatchResult): MatchResult[] {
  return RESULTS.filter((x) => (x === r ? !results.includes(x) : results.includes(x)));
}

export const HISTORY_PAGE = 10;

/** One page of rows (1-based, clamped to the pages that exist). */
export function historyPage<T>(rows: T[], page: number, size = HISTORY_PAGE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}

/** An Account key as shown everywhere: first four, last four. */
export const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/** The Gema change of a row as shown: a backed Player's loss is "0 Gemas", never their entry. */
export function amountText(r: HistoryRow): string {
  if (r.result === "draw") return "Entry returned";
  if (r.result === "refunded") return "Entry refunded";
  const sign = r.delta > 0 ? "+" : r.delta < 0 ? "−" : "";
  return `${sign}${fmtGemas(Math.abs(r.delta))} Gemas`;
}

/** Who else was in the Backing, worded as the Result screen's split does. Null for an unbacked Match. */
export function backingText(r: HistoryRow): string | null {
  if (!r.backing) return null;
  const other = shortKey(r.backing.other);
  if (r.role === "backer") return `You backed ${other}`;
  return r.result === "lost" ? `Backer ${other} bore the loss` : `Backed by ${other}`;
}
