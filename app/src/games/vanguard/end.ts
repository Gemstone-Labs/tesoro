import { STATUS, type Battle } from "./decode";
import { type EndReason } from "./rules";

const REASONS: EndReason[] = ["truck", "stuck", "timeouts", "cap"];

const TITLE: Record<EndReason, string> = {
  truck: "Supply Truck captured",
  stuck: "No move left",
  timeouts: "Out of time",
  cap: "Limit reached",
};

const LINE = {
  truck: { won: "You captured their Truck.", lost: "They captured your Truck." },
  stuck: { won: "They can't move.", lost: "You can't move." },
  timeouts: { won: "They ran out of time.", lost: "You ran out of time." },
  cap: { won: "Limit reached: you were ahead.", lost: "Limit reached: they were ahead." },
} as const;

export interface EndWhy {
  title: string;
  line: string;
}

/** Why the Match ended, from this Player's seat: a short title and one plain sentence. Null while it is still on. */
export function endWhy(b: Battle, seat: number): EndWhy | null {
  if (b.status === STATUS.cancelled) return { title: "Match cancelled", line: "Match cancelled: refunded." };
  if (b.status !== STATUS.over) return null;
  const reason = REASONS[b.reason] ?? "cap";
  if (b.winner === 2) return { title: "Draw", line: "Draw: entries refunded." };
  return { title: TITLE[reason], line: LINE[reason][b.winner === seat ? "won" : "lost"] };
}

/** The line under the board once the Battle is decided, from this Player's seat. */
export const endLine = (b: Battle, seat: number): string => endWhy(b, seat)?.line ?? LINE.cap.won;
