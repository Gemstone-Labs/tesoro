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
      ? "Your result is saved; your winnings show in your Vault once it lands. You can leave this page."
      : "Your result is saved and will show once it lands. You can leave this page.",
  };
}

const KEY = "tesoro:commit-pending";
/** A marker older than this is dropped, so a Match that never reports back cannot stick on Home. */
export const MARKER_TTL_MS = 48 * 3_600_000;

type Marker = { id: string; at: number };

function read(now: number): Marker[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Marker => typeof x?.id === "string" && typeof x?.at === "number" && now - x.at < MARKER_TTL_MS);
  } catch {
    return [];
  }
}

function write(markers: Marker[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(markers.slice(-20)));
  } catch {
    // Private mode: the Home cards just keep saying Resume.
  }
}

/** Remember, in this browser, that a Match's result is on its way, so Home can say so instead of inviting a Resume. */
export function setCommitPending(id: bigint | string, pending: boolean, now = Date.now()) {
  const key = id.toString();
  const rest = read(now).filter((x) => x.id !== key);
  write(pending ? [...rest, { id: key, at: now }] : rest);
}

/** When this browser first saw the Match's commit pending (ms), or null. */
export function commitPendingSince(id: bigint | string, now = Date.now()): number | null {
  return read(now).find((x) => x.id === id.toString())?.at ?? null;
}

/** The ids as one comma-joined string: a stable snapshot for useSyncExternalStore. */
export function commitPendingKey(now = Date.now()): string {
  return read(now).map((x) => x.id).join(",");
}
