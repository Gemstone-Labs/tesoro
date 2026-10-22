import { STATUS, type Battle } from "./decode";
import { NAMES, type Army, type EndReason } from "./rules";
import { armyOfPiece, mySide } from "./view";

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

export interface ChangedPiece {
  id: number;
  mine: boolean;
  text: string;
}

/**
 * The end panel's marks, from the end mask the program writes when the Match ends (and not before): every piece whose rank
 * changed, dead ones included. A changed piece plays as a Landmine (a Major that dug in) or a Spy (a General of the Army that
 * became one), which is the rank the Battle publishes for it. Empty for a Match that is not over, and for a v5 Battle.
 */
export function changedPieces(b: Battle, seat: number): ChangedPiece[] {
  if (b.status !== STATUS.over || b.endMask === 0n) return [];
  const side: Army = mySide(b, seat);
  const out: ChangedPiece[] = [];
  for (let id = 0; id < 60; id++) {
    if (((b.endMask >> BigInt(id)) & 1n) === 0n) continue;
    const text = b.shown[id] === 11 ? `${NAMES["7"]}, dug in` : b.shown[id] === 1 ? `${NAMES["10"]}, now a Spy` : null;
    if (text) out.push({ id, mine: armyOfPiece(id) === side, text });
  }
  return out;
}
