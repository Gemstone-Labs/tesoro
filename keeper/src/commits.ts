import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import type { PublicKey } from "@solana/web3.js";
import { log } from "./act.ts";

/** A commit still pending after this is worth a person's look. */
export const COMMIT_WARN_MS = 5 * 60_000;

/** close_match refuses with Anchor 3007 once the game account is already owned by the delegation program. */
export const isCommitPending = (msg: string) => /AccountOwnedByWrongProgram|\b3007\b|0xbbf\b/.test(msg);

/**
 * Matches whose close_match is in: the rollup has to commit the result back. Resending close_match cannot speed that
 * up (the account is delegation-owned and refuses it), so each Match is noted once, warned about once when it
 * stays pending, and counted in /healthz until it is back on the base layer.
 */
export class CommitTracker {
  private since = new Map<string, number>();
  private warned = new Set<string>();

  has(subject: string) {
    return this.since.has(subject);
  }

  /** True the first time a Match is noted. */
  begin(subject: string, now = Date.now()): boolean {
    if (this.since.has(subject)) return false;
    this.since.set(subject, now);
    return true;
  }

  clear(subject: string) {
    this.since.delete(subject);
    this.warned.delete(subject);
  }

  /** True once per Match, the first time it is seen pending past the warn limit. */
  shouldWarn(subject: string, now = Date.now()): boolean {
    const at = this.since.get(subject);
    if (at === undefined || now - at < COMMIT_WARN_MS || this.warned.has(subject)) return false;
    this.warned.add(subject);
    return true;
  }

  age(subject: string, now = Date.now()): number {
    return Math.round((now - (this.since.get(subject) ?? now)) / 1000);
  }

  stats(now = Date.now()) {
    let oldest = 0;
    for (const at of this.since.values()) oldest = Math.max(oldest, now - at);
    return { commitsPending: this.since.size, oldestCommitPendingSecs: Math.round(oldest / 1000) };
  }
}

export const commits = new CommitTracker();

/**
 * Before sending close_match: true (and logged) when this Match's commit is already pending, either because the keeper
 * sent close_match earlier or because the game account in the rollup is owned by the delegation program.
 */
export function commitInFlight(subject: string, tag: string, teeOwner: PublicKey | null, tracker = commits, now = Date.now()): boolean {
  if (teeOwner?.equals(DELEGATION_PROGRAM_ID)) tracker.begin(subject, now);
  if (!tracker.has(subject)) return false;
  if (tracker.shouldWarn(subject, now)) log("match", subject, `${tag} WARN commit pending for ${tracker.age(subject, now)}s: the rollup has not handed the result back`);
  else log("match", subject, `${tag} wait: close_match sent, commit pending ${tracker.age(subject, now)}s`);
  return true;
}

/** After close_match: a sent close or a 3007 refusal both mean the commit is pending; log it once. */
export function noteClose(subject: string, tag: string, outcome: { ok: boolean; detail: string }, tracker = commits, now = Date.now()) {
  if (!outcome.ok && !isCommitPending(outcome.detail)) return;
  if (tracker.begin(subject, now)) log("match", subject, `${tag} commit pending: waiting for the rollup to hand the result back (not resending close_match)`);
}
