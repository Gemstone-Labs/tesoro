
/**
 * tesoro_core::MATCH_TIMEOUT_SECS: how long after a join the Match's refund deadline is set. The
 * Block Burst Queue window (24 h, before anyone joins) does not change it: a join resets it.
 */
const CORE_WINDOW_SECS = 60 * 60;
/** trading_duel START_WINDOW_SECS + MATCH_SECS (30 s head start + 12 columns of 10 s): the longest a Duel runs after the join. */
const DUEL_PLAY_SECS = 300 + 150;
/** Time the rollup is given to commit a finished Match back to the chain before it counts as late. */
export const SETTLE_GRACE_SECS = 120;

/**
 * Where a Match stands, from its on-chain state and the clock alone, so every device agrees.
 * `delayed`: it should have settled by now and has not. The Gemas are safe: the Match refunds by
 * `refundBy` (unix seconds, tesoro_core's deadline); once that has passed (`refundOpen`) anyone may refund it.
 */
export type MatchStanding =
  | { kind: "open" }
  | { kind: "live" }
  | { kind: "delayed"; refundBy: number; refundOpen: boolean }
  | { kind: "settled" }
  | { kind: "refunded" };

/**
 * The fields of a ChainMatch this needs, spelled out so the keeper can import this file without
 * pulling in the app's chain readers (and their `@/` imports).
 */
type Input = {
  status: "open" | "active" | "settled" | "refunded";
  game: "block-puzzle" | "holdem" | "trading-duel";
  deadline: number;
  session?: { deadline: number; openerDeadline: number } | null;
};

/**
 * Unix seconds after which an Active Match should have settled, never later than its refund deadline.
 * - Block Burst: both submission deadlines have passed, so `seal` and settle are open to anyone.
 * - Trading Duel: the join, plus the start window, plus the Duel itself.
 * - Hold'em: no fixed end exists in the Match state, so only the refund deadline counts.
 */
export function settleBy(m: Pick<Input, "game" | "deadline" | "session">): number {
  const core = m.deadline;
  let end: number;
  if (m.game === "block-puzzle" && m.session && m.session.deadline > 0) {
    end = Math.max(m.session.deadline, m.session.openerDeadline) + SETTLE_GRACE_SECS;
  } else if (m.game === "trading-duel") {
    end = core - CORE_WINDOW_SECS + DUEL_PLAY_SECS + SETTLE_GRACE_SECS;
  } else {
    end = core;
  }
  return Math.min(end, core);
}

export function matchStanding(m: Input, nowSecs: number): MatchStanding {
  if (m.status === "open") return { kind: "open" };
  if (m.status === "settled" || m.status === "refunded") return { kind: m.status };
  if (nowSecs < settleBy(m)) return { kind: "live" };
  return { kind: "delayed", refundBy: m.deadline, refundOpen: nowSecs >= m.deadline };
}

/** The Delayed standing of a Match, or null when it is anything else. */
export function delayedOf(m: Input, nowSecs: number): { refundBy: number; refundOpen: boolean } | null {
  const s = matchStanding(m, nowSecs);
  return s.kind === "delayed" ? { refundBy: s.refundBy, refundOpen: s.refundOpen } : null;
}

/** The Delayed Matches among `matches`, soonest refund first. */
export function delayedMatches<T extends Input>(matches: T[], nowSecs: number): T[] {
  return matches
    .filter((m) => matchStanding(m, nowSecs).kind === "delayed")
    .sort((a, b) => a.deadline - b.deadline);
}

/** "4:12 pm", or "Thu 4:12 pm" when it is not today. */
export function refundByText(refundBy: number, nowMs: number): string {
  const d = new Date(refundBy * 1000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(nowMs).toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** One line for cards and lists. */
export function delayedLine(s: Extract<MatchStanding, { kind: "delayed" }>, nowMs: number): string {
  return s.refundOpen ? "Delayed, refund is open" : `Delayed, refunds by ${refundByText(s.refundBy, nowMs)}`;
}
