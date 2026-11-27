import { matchFee } from "@/lib/chain/ledger";
import { refundByText, tableRefundBy } from "@/lib/chain/match-status";
import { resultOf, type ChainMatch } from "@/lib/chain/read";

/**
 * Where a Match stands for someone watching it. tesoro_core's stage gives all of it but one step: an Active Match is waiting
 * for a table until its Game has written the Assignment, and in play from then on.
 */
export type SpectateState = "open" | "table" | "live" | "over" | "settling" | "refunding" | "settled" | "refunded";

/** One read of a watched Match: the Match, whether its Game has assigned it a table, and when it was read (ms). */
export interface Spectated {
  m: ChainMatch;
  tabled: boolean;
  at: number;
  /** The Match account is closed and the history has no result for it yet: it is over, how is not known. */
  unrecorded?: boolean;
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
export const stateOf = (seen: Spectated): SpectateState => (seen.unrecorded ? "over" : spectateState(seen.m, seen.tabled));

/** The page reads again until the Match is settled or refunded; before the first read and after an unknown Match too. */
export const keepsReading = (seen: Spectated | null | undefined): boolean => seen === undefined || (seen !== null && !["settled", "refunded"].includes(stateOf(seen)));

const isPending = (s: SpectateState) => s === "open" || s === "table" || s === "live";

/** The headline. `winner` is the winning Player's name once a win is fixed, null for a draw. */
export function spectateHeadline(s: SpectateState, winner: string | null): string {
  switch (s) {
    case "open": return "Waiting for an opponent";
    case "table": return "Waiting for a table";
    case "live": return "In play";
    case "over": return "Match over";
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
    case "over":
      return "This Match is over. Its result is still being recorded and will show here by itself.";
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
  /** Whether the Match's Game has assigned it a table. */
  tabled: (m: ChainMatch) => Promise<boolean>;
  now: () => number;
}

/**
 * One read for the spectator page: the Match and, while it is Active, its table. Null when no such Match exists; undefined
 * when the read failed, so the page keeps what it shows and reads again.
 */
export async function readSpectated(id: string, d: SpectateReads, wasTabled = false): Promise<Spectated | null | undefined> {
  try {
    const m = await d.fetchMatch(id);
    if (!m) return m;
    const active = m.status === "active" && !m.running;
    // Only the history gives a Match no refund deadline: the account is closed, and an Active one from there has no result written yet.
    if (active && !m.deadline) return { m, tabled: wasTabled, at: d.now(), unrecorded: true };
    return { m, tabled: active ? wasTabled || (await d.tabled(m)) : wasTabled, at: d.now() };
  } catch {
    return undefined;
  }
}

const RANK: Record<SpectateState, number> = { open: 0, table: 1, live: 2, over: 3, settling: 4, refunding: 4, settled: 5, refunded: 5 };

/** What the page shows after a read: the new read, unless it says nothing or would step the Match back (a lagging read). */
export function laterRead(prev: Spectated | null | undefined, next: Spectated | null | undefined): Spectated | null | undefined {
  if (next === undefined) return prev;
  if (!prev) return next;
  if (next === null) return prev;
  return RANK[stateOf(next)] < RANK[stateOf(prev)] ? prev : next;
}
