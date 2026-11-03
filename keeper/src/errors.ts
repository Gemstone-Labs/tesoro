import { log } from "./act.ts";
let count = 0;

/** Failures reported so far in this process: caught errors and failed actions. The Season run reads it around each step. */
export const errorCount = () => count;

/** Counts a failure without logging it (a failed action logs its own FAIL line). */
export const countError = () => void count++;

/** Logs a caught error as `ERROR` and counts it, so a job that goes on to its next item still reports that one failed. */
export function noteError(job: string, subject: string, e: unknown) {
  count++;
  log(job, subject, `ERROR ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}`);
}
