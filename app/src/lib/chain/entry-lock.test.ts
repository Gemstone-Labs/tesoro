import { describe, expect, it } from "vitest";
import { queueLockName, withEntryLock } from "./entry-lock";

/** A LockManager stand-in: one holder per name, the rest wait in order (what `navigator.locks.request` does). */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

describe("withEntryLock (ticket 63)", () => {
  it("runs a second Queue entry of the same Account and Game only after the first is done", async () => {
    // 2026-11-09: two entry runs of one phone joined 6qPL…-10 at once; one failed and opened a second Match.
    const locks = fakeLocks();
    const order: string[] = [];
    let release!: () => void;
    const first = withEntryLock("q", async () => {
      order.push("first starts");
      await new Promise<void>((r) => (release = r));
      order.push("first ends");
    }, locks);
    const second = withEntryLock("q", async () => void order.push("second starts"), locks);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first starts"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first starts", "first ends", "second starts"]);
  });

  it("runs at once where the browser has no Web Locks", async () => {
    expect(await withEntryLock("q", async () => 7, undefined)).toBe(7);
  });

  it("names one lock per Account and Game", () => {
    expect(queueLockName("acct", "block-puzzle")).not.toBe(queueLockName("acct", "holdem"));
    expect(queueLockName("acct", "block-puzzle")).not.toBe(queueLockName("other", "block-puzzle"));
  });
});
