import { replanInstant, type InstantLine } from "./fees";

/** The program refused an Instant Redeem because a yield crank landed first: those Gemas are no longer pending. */
export const isExceedsPending = (e: unknown) => /only Gemas whose yield has not landed/i.test(e instanceof Error ? e.message : String(e));

export type InstantRun =
  | { kind: "sent"; sent: InstantLine[] }
  | { kind: "smaller"; lines: InstantLine[]; gemas: bigint; sent: InstantLine[] }
  | { kind: "none"; sent: InstantLine[] };

/**
 * Sends the lines the Player confirmed, one at a time, after a fresh read (`read`, newest plan). Never sends more than
 * confirmed: a smaller read stops and returns the new amount. If a send fails with ExceedsPending (a crank landed between the
 * read and the send), the unsent lines are read and replanned once the same way; any other failure is thrown.
 */
export async function runInstant(confirmed: InstantLine[], read: () => Promise<InstantLine[]>, send: (line: InstantLine) => Promise<void>): Promise<InstantRun> {
  const sent: InstantLine[] = [];
  let todo = confirmed;
  let retried = false;
  for (;;) {
    const replan = replanInstant(todo, await read());
    if (replan.kind === "none") return { kind: "none", sent };
    if (replan.kind === "smaller") return { kind: "smaller", lines: replan.lines, gemas: replan.gemas, sent };
    todo = replan.lines;
    try {
      while (todo.length > 0) {
        await send(todo[0]);
        sent.push(todo[0]);
        todo = todo.slice(1);
      }
      return { kind: "sent", sent };
    } catch (e) {
      if (retried || !isExceedsPending(e)) throw e;
      retried = true;
    }
  }
}
