import { matchFee } from "@/lib/chain/ledger";
import { delayedOf, refundByText, tableRefundBy } from "@/lib/chain/match-status";
import { resultOf, type ChainMatch, type ClosedOutcome } from "@/lib/chain/read";

/**
 * Where a Match stands for someone watching it. tesoro_core's stage gives all of it but one step: an Active Match is waiting
 * for a table until its Game has written the Assignment, and in play from then on.
 */
export type SpectateState = "open" | "table" | "live" | "delayed" | "over" | "settling" | "refunding" | "settled" | "refunded";

/** One read of a watched Match: the Match, whether its Game has assigned it a table, and when it was read (ms). */
export interface Spectated {
  /** Null only on a first read of a Match that is already closed and not in the history yet: just `closed` is known. */
  m: ChainMatch | null;
  tabled: boolean;
  /** Unix seconds by which a Match on this table has been played and settled, when its Game's Assignment tells; a Match still Active after it is not in play. */
  playedBy?: number | null;
  at: number;
  /**
   * The Match account is closed and the history has no result for it yet (it can take minutes): how the Match ended, from the
   * chain's settlement receipt, or "unknown" when that could not be told.
   */
  closed?: ClosedOutcome | "unknown";
}

type Staged = Pick<ChainMatch, "status" | "running" | "fixed">;

export function spectateState(m: Staged, tabled: boolean): SpectateState {
  if (m.status === "settled" || m.status === "refunded") return m.status;
  // The run is paying: how it ends is fixed (a no-show runs as a settlement and ends as a refund).
  if (m.running) return (resultOf(m) ?? (m.running === "refunding" ? "refunded" : "settled")) === "refunded" ? "refunding" : "settling";
  if (m.status === "open") return "open";
  return tabled ? "live" : "table";
}

/** Where a read puts the Match. */
export function stateOf(seen: Spectated): SpectateState {
  if (seen.closed || !seen.m) return "over";
  const s = spectateState(seen.m, seen.tabled);
  // Assigned a table, yet past the time any Match on it lasts (or past the time its Game gives a Match): it never started, or its result is late.
  const nowSecs = seen.at / 1000;
  return s === "live" && ((seen.playedBy != null && nowSecs > seen.playedBy) || delayedOf(seen.m, nowSecs)) ? "delayed" : s;
}

/** The winning seat a read knows of: from the receipt of a closed Match, else from the Match once its result is fixed. */
export function winSeatOf(seen: Spectated): 0 | 1 | null {
  if (seen.closed) return seen.closed === "opener" ? 0 : seen.closed === "joiner" ? 1 : null;
  const m = seen.m;
  const s = stateOf(seen);
  if (!m || (s !== "settled" && s !== "settling")) return null;
  const result = m.session ? (m.session.settled ? m.session.result : null) : m.winner;
  return result === "opener" ? 0 : result === "joiner" ? 1 : null;
}

/** The page reads again until the Match is settled or refunded; before the first read and after an unknown Match too. */
export const keepsReading = (seen: Spectated | null | undefined): boolean => seen === undefined || (seen !== null && !["settled", "refunded"].includes(stateOf(seen)));

const isPending = (s: SpectateState) => s === "open" || s === "table" || s === "live" || s === "delayed";

/** The headline. `winner` is the winning Player's name once a win is fixed, null for a draw. `closed` tells how a Match in "over" ended. */
export function spectateHeadline(s: SpectateState, winner: string | null, closed?: Spectated["closed"]): string {
  if (s === "over") return closed === "refund" ? "Refunded" : closed === "draw" ? "Draw" : winner ? `${winner} won` : "Match over";
  switch (s) {
    case "open": return "Waiting for an opponent";
    case "table": return "Waiting for a table";
    case "live": return "In play";
    case "delayed": return "Delayed";
    case "refunding": return "Refunding";
    case "refunded": return "Refunded";
    default: return winner ? `${winner} won` : "Draw";
  }
}

/**
 * The Fee line. While the outcome is pending it is the Fee a win takes, at the Match's own rates. Once the outcome is fixed it
 * is the Fee the chain charged: a win's Fees, 0 for a full refund, the Platform Fee of a no-show. Null when the charged
 * amount is not known yet (the history is still writing the result).
 */
export function spectateFee(m: Pick<ChainMatch, "entry" | "fees" | "settled" | "sides">, s: SpectateState): { label: "Fee on a win" | "Fee charged"; fee: number } | null {
  if (isPending(s)) return { label: "Fee on a win", fee: matchFee({ entry: m.entry, fees: m.fees }) };
  if (s === "over") return null;
  if (m.settled) return { label: "Fee charged", fee: m.settled.fee };
  // Nobody joined: the entry goes back whole.
  return (s === "refunding" || s === "refunded") && !m.sides[1] ? { label: "Fee charged", fee: 0 } : null;
}

/** The line under the result: what the spectator is looking at and what happens next. */
export function spectateLine(m: Pick<ChainMatch, "deadline" | "sides" | "settled" | "winner">, s: SpectateState, nowMs: number, hidden: string): string {
  switch (s) {
    case "open":
    case "live":
      return `You are watching a Match you are not part of. ${hidden} stay hidden until it settles.`;
    case "table": {
      const by = tableRefundBy(m.deadline, nowMs / 1000);
      if (by === null) return "Both Players are in. The Match starts when a table opens.";
      return by * 1000 > nowMs
        ? `Both Players are in. The Match starts when a table opens. If none opens by ${refundByText(by, nowMs)}, both entries come back.`
        : "No table opened in time. Both entries are on their way back.";
    }
    case "delayed":
      return m.deadline * 1000 > nowMs
        ? `This Match should have finished by now. The entries are safe: if it does not settle, both come back by ${refundByText(m.deadline, nowMs)}.`
        : "This Match should have finished by now. The entries are safe and due back to both Players.";
    case "over":
      return "This Match is over and its result is final. The amounts are still being recorded and will show here by themselves.";
    case "refunding":
      if (!m.sides[1]) return "Nobody joined. The entry is on its way back.";
      // A no-show: each side pays its Platform Fee and gets the rest of its entry back.
      return m.settled?.fee ? "This Match ended without a winner. Each entry is on its way back, less the Platform Fee." : "This Match ended without a winner. Both entries are on their way back.";
    case "settling":
      return m.winner ? "You are viewing a Match you were not part of. The result is final and the Pot is being paid out." : "You are viewing a Match you were not part of. The result is final and both entries are on their way back.";
    default:
      return "You are viewing a Match you were not part of. The result is final.";
  }
}

export interface SpectateReads {
  fetchMatch: (id: string) => Promise<ChainMatch | null>;
  /** The table the Match's Game has assigned it: null while it has none, else when a Match on it is over at the latest (null when the Game sets no such time). */
  table: (m: ChainMatch) => Promise<{ playedBy: number | null } | null>;
  /** How a closed Match ended, from its settlement receipt; null when it has none. */
  outcome: (id: string) => Promise<ClosedOutcome | null>;
  now: () => number;
}

/**
 * One read for the spectator page: the Match and, while it is Active, its table. `prev` is what the page shows now. Null when
 * no such Match exists; undefined when the read failed, so the page keeps what it shows and reads again.
 * A Match account is closed minutes before the history has its result. In between, the chain's settlement receipt still says
 * how it ended: the read is then the last known Match (or the history's unfinished page, or nothing on a first read) with `closed`.
 */
export async function readSpectated(id: string, d: SpectateReads, prev?: Spectated | null): Promise<Spectated | null | undefined> {
  try {
    const m = await d.fetchMatch(id);
    const tabled = !!prev?.tabled;
    const playedBy = prev?.playedBy ?? null;
    const active = !!m && m.status === "active" && !m.running;
    // Only the history gives a Match no refund deadline: an Active one from there is a closed Match with no result written yet.
    if (!m || (active && !m.deadline)) {
      const how = await d.outcome(id);
      if (!how && !m) return prev ? undefined : null;
      return { m: m ?? prev?.m ?? null, tabled, playedBy, at: d.now(), closed: how ?? "unknown" };
    }
    // The Assignment never changes once written: it is read until it exists, not after.
    const table = active && !tabled ? await d.table(m) : null;
    return { m, tabled: tabled || !!table, playedBy: table ? table.playedBy : playedBy, at: d.now() };
  } catch {
    return undefined;
  }
}

// A closed Match with no history yet ranks under a run being paid: that read has the amounts, this one only the outcome.
const RANK: Record<SpectateState, number> = { open: 0, table: 1, live: 2, delayed: 2, over: 3, settling: 4, refunding: 4, settled: 5, refunded: 5 };

/** What the page shows after a read: the new read, unless it says nothing or would step the Match back (a lagging read). */
export function laterRead(prev: Spectated | null | undefined, next: Spectated | null | undefined): Spectated | null | undefined {
  if (next === undefined) return prev;
  if (!prev) return next;
  if (next === null) return prev;
  return RANK[stateOf(next)] < RANK[stateOf(prev)] ? prev : next;
}
