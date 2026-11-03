import { log } from "./act.ts";

/** A failure reported by a job: `source` is set when it belongs to one Source (a `source=<key>` subject), else null. */
export interface Failure {
  job: string;
  subject: string;
  source: string | null;
}

const failures: Failure[] = [];

/** The Source a subject names, by the `source=<key>` convention of the jobs that work per Source; null for any other subject. */
export const sourceOf = (subject: string): string | null => (subject.startsWith("source=") ? subject.slice("source=".length) : null);

/** How many failures were reported so far; pass it to `failuresSince`. */
export const failureMark = () => failures.length;

/** The failures reported after `mark`. The Season run reads them around each step. */
export const failuresSince = (mark: number): Failure[] => failures.slice(mark);

/** Counts a failure without logging it (a failed action logs its own FAIL line). */
export const countError = (job: string, subject: string) => void failures.push({ job, subject, source: sourceOf(subject) });

/** Logs a caught error as `ERROR` and counts it, so a job that goes on to its next item still reports that one failed. */
export function noteError(job: string, subject: string, e: unknown) {
  countError(job, subject);
  log(job, subject, `ERROR ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}`);
}
