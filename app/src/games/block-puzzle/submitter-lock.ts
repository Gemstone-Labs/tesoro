/** The part of the Web Locks API the submitter lock uses. */
export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T> | T): Promise<T>;
}

export interface SubmitterLock {
  /** True when this tab holds the lock: it is the one that sends the moves. */
  held: boolean;
  /** Gives the lock up (the Match is over or the page closes). */
  release(): void;
}

/**
 * One submitter per Account per Match. The first tab to ask holds a named lock until `release` (or until it closes); any other
 * tab of the same browser is refused and tells its Player the Match is playing elsewhere. A browser without Web Locks (or
 * with them blocked) cannot tell, so it holds: the program still refuses a second writer's out-of-order batch (`WrongCount`).
 */
export async function acquireSubmitterLock(matchKey: string, account: string, locks: LockManagerLike | undefined = typeof navigator === "undefined" ? undefined : (navigator as { locks?: LockManagerLike }).locks): Promise<SubmitterLock> {
  if (!locks) return { held: true, release: () => {} };
  let release: () => void = () => {};
  const done = new Promise<void>((r) => (release = r));
  const got = await new Promise<boolean>((resolve) => {
    locks
      .request(`tesoro-burst:${account}:${matchKey}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock ? done : undefined;
      })
      .catch(() => resolve(true));
  });
  return { held: got, release };
}
