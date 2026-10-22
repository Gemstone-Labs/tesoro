import { plainError } from "@/lib/errors";

/** The program's messages for a declare it refused, as one short line each. The board snaps back either way. */
const LINES: [RegExp, string][] = [
  [/turn has expired/i, "Too late: your turn ran out."],
  [/time cap has passed/i, "Time limit passed."],
  [/match is over/i, "Match is over."],
  [/action is waiting/i, "Last move still applying."],
  [/not your turn/i, "Not your turn."],
  [/Error Message: Not allowed/i, "Move not possible."],
  [/sealed for an earlier turn/i, "The board moved on. Try again."],
];

/** The declare named a turn that is over (`StaleSeq`): the board this client drew was behind, so it is read again and snapped to what is confirmed. */
export const isStale = (e: unknown): boolean => /sealed for an earlier turn/i.test(e instanceof Error ? e.message : String(e));

export function refusalLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return LINES.find(([re]) => re.test(text))?.[1] ?? plainError(e);
}
