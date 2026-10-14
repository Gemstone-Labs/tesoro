/** A finished Match whose result the rollup has not committed back to the chain yet. */
export type CommitPhase = "sending" | "slow";

export interface CommitState {
  phase: CommitPhase;
  /** The Player took the Pot (or gets their entry back), so there is something to wait for in the Wallet. */
  won: boolean;
}

/** After this long the Player is told it is taking longer than usual. */
export const COMMIT_SLOW_MS = 120_000;

/** close_match refuses with Anchor 3007 once the game account is already owned by the delegation program: the commit is scheduled and in flight. */
export function isCommitPending(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /AccountOwnedByWrongProgram|\b3007\b|0xbbf\b/.test(text);
}

export function commitPhase(sinceMs: number, nowMs: number): CommitPhase {
  return nowMs - sinceMs >= COMMIT_SLOW_MS ? "slow" : "sending";
}

export function commitCopy(c: CommitState): { title: string; line: string } {
  if (c.phase === "sending") return { title: "Your result is in", line: "Sending it to the chain…" };
  return {
    title: "Taking longer than usual",
    line: c.won
      ? "Your result is saved; your winnings show in your Wallet once it lands. You can leave this page."
      : "Your result is saved and will show once it lands. You can leave this page.",
  };
}

const KEY = "tesoro:commit-pending";

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-20)));
  } catch {
    // Private mode: the Home cards just keep saying Resume.
  }
}

/** Remember, in this browser, that a Match's result is on its way, so Home can say so instead of inviting a Resume. */
export function setCommitPending(id: bigint | string, pending: boolean) {
  const key = id.toString();
  const ids = read().filter((x) => x !== key);
  write(pending ? [...ids, key] : ids);
}

/** The ids as one comma-joined string: a stable snapshot for useSyncExternalStore. */
export function commitPendingKey(): string {
  return read().join(",");
}
