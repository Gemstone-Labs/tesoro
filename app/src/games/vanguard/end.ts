import { STATUS, type Battle } from "./decode";
import type { EndReason } from "./rules";

const REASONS: EndReason[] = ["truck", "stuck", "timeouts", "cap"];

const TITLE: Record<EndReason, string> = {
  truck: "Supply Truck captured",
  stuck: "No move left",
  timeouts: "Out of time",
  cap: "Limit reached",
};

const LINE = {
  truck: { won: "You captured their Supply Truck.", lost: "They captured your Supply Truck." },
  stuck: { won: "They have no piece left that can move.", lost: "You have no piece left that can move." },
  timeouts: { won: "They let the clock run out three turns in a row.", lost: "Your clock ran out three turns in a row." },
  cap: { won: "Time or move limit reached: you had the stronger army left.", lost: "Time or move limit reached: they had the stronger army left." },
} as const;

export interface EndWhy {
  title: string;
  line: string;
}

/** Why the Match ended, from this Player's seat: a short title and one plain sentence. Null while it is still on. */
export function endWhy(b: Battle, seat: number): EndWhy | null {
  if (b.status === STATUS.cancelled) return { title: "Match cancelled", line: "The Match was cancelled. Both entries are refunded." };
  if (b.status !== STATUS.over) return null;
  const reason = REASONS[b.reason] ?? "cap";
  if (b.winner === 2) return { title: "Draw", line: "Time or move limit reached with equal armies: both entries are refunded." };
  return { title: TITLE[reason], line: LINE[reason][b.winner === seat ? "won" : "lost"] };
}

/** The line under the board once the Battle is decided, from this Player's seat. */
export const endLine = (b: Battle, seat: number): string => endWhy(b, seat)?.line ?? LINE.cap.won;
