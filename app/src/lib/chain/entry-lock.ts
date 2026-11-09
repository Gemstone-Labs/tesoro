import type { GameId } from "@/lib/mock/types";

type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> };

/** The lock one Account's Queue entry for one Game holds, across this browser's tabs and page instances. */
export const queueLockName = (account: string, game: GameId) => `tesoro-queue-entry-${account}-${game}`;

/**
 * Runs `fn` while holding `name`: a second entry of the same Account and Game waits for the first, then finds the Match it
 * entered (`queueEntry` returns it as "existing") instead of joining or opening another (ticket 63). Without Web Locks it runs at once.
 */
export function withEntryLock<T>(name: string, fn: () => Promise<T>, locks: Locks | undefined = typeof navigator === "undefined" ? undefined : (navigator.locks as Locks | undefined)): Promise<T> {
  return locks ? locks.request(name, fn) : fn();
}

const RECENT_KEY = "tesoro:queue-entry";
/** How long the last entry is checked first: longer than the list read can lag, shorter than a Match. */
export const RECENT_ENTRY_MS = 10 * 60_000;

/** Remembers the Match a Queue entry went into, for this browser's next entry under the same lock name. */
export function rememberQueueEntry(name: string, id: string, now = Date.now()): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, { id: string; at: number }>;
    all[name] = { id, at: now };
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // no storage (private window): the list read alone decides
  }
}

/** The Match the last Queue entry under `name` went into, while recent. */
export function recentQueueEntry(name: string, now = Date.now()): string | null {
  try {
    const hit = (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, { id: string; at: number }>)[name];
    return hit && typeof hit.id === "string" && now - hit.at < RECENT_ENTRY_MS ? hit.id : null;
  } catch {
    return null;
  }
}
