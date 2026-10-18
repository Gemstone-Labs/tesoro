import { plainError } from "@/lib/errors";

/** The program's messages for a declare it refused, as one short line each. The board snaps back either way. */
const LINES: [RegExp, string][] = [
  [/turn has expired/i, "Too late: your turn already ran out."],
  [/time cap has passed/i, "The time limit has passed. The Match is being counted."],
  [/match is over/i, "The Match is over."],
  [/action is waiting/i, "Your last move is still being applied. Wait a moment."],
  [/not your turn/i, "It is not your turn. The board was refreshed."],
  [/Error Message: Not allowed/i, "That move is not possible on the current board. The board was refreshed."],
];

export function refusalLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return LINES.find(([re]) => re.test(text))?.[1] ?? plainError(e);
}
