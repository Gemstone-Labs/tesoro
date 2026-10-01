import { fmtGemas } from "../format";
import type { GameId, MatchResult } from "../mock/types";
import { backerDelta, matchDelta, seatResult } from "./ledger";
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
}

/** The history row of a finished Match, or null while it is unfinished or its result is not read yet. */
export function historyRow(m: ChainMatch): HistoryRow | null {
  if (m.status !== "settled" && m.status !== "refunded") return null;
  const role = m.seat !== null ? "player" : m.backing && m.backerSeat !== null ? "backer" : null;
  if (!role) return null;
  const seat = m.seat ?? (m.backing as NonNullable<ChainMatch["backing"]>).seat;
  const draw = !!m.session?.settled && m.session.result === "draw";
  const refunded = m.status === "refunded" || (m.game === "block-puzzle" && !m.session);
  const result = draw ? "draw" : refunded ? "refunded" : seatResult(m, seat);
  // A settled Hold'em Match whose table could not be read: the next refresh fills it in.
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
    at: Number(m.id >> 1n),
  };
}

/** Every finished Match of an Account (played and funded), newest first. */
export function accountHistory(played: ChainMatch[], funded: ChainMatch[] = []): HistoryRow[] {
  return [...played, ...funded]
    .map(historyRow)
    .filter((r): r is HistoryRow => r !== null)
    .sort((a, b) => b.at - a.at);
}

export const HISTORY_PAGE = 20;

/** One page of rows (1-based, clamped to the pages that exist). */
export function historyPage<T>(rows: T[], page: number, size = HISTORY_PAGE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

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
  const other = short(r.backing.other);
  if (r.role === "backer") return `You backed ${other}`;
  return r.result === "lost" ? `Backer ${other} bore the loss` : `Backed by ${other}`;
}
