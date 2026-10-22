import { describe, expect, it } from "vitest";
import { acquireSubmitterLock, type LockManagerLike } from "./submitter-lock";

/** A Web Locks stand-in shared by "tabs": a name is held until the callback's promise settles. */
function locks(): LockManagerLike {
  const held = new Set<string>();
  return {
    request: async <T,>(name: string, _o: { ifAvailable: true }, cb: (lock: object | null) => Promise<T> | T): Promise<T> => {
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        return await cb({});
      } finally {
        held.delete(name);
      }
    },
  };
}

describe("one submitter per Account per Match", () => {
  it("the first tab holds the lock; a second tab of the same Match is told it is playing elsewhere", async () => {
    const manager = locks();
    const first = await acquireSubmitterLock("m-1", "acct", manager);
    const second = await acquireSubmitterLock("m-1", "acct", manager);
    expect(first.held).toBe(true);
    expect(second.held).toBe(false);
  });

  it("releasing the lock lets another tab take it", async () => {
    const manager = locks();
    const first = await acquireSubmitterLock("m-1", "acct", manager);
    first.release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await acquireSubmitterLock("m-1", "acct", manager)).held).toBe(true);
  });

  it("another Match, or another Account, is a different lock", async () => {
    const manager = locks();
    await acquireSubmitterLock("m-1", "acct", manager);
    expect((await acquireSubmitterLock("m-2", "acct", manager)).held).toBe(true);
    expect((await acquireSubmitterLock("m-1", "other", manager)).held).toBe(true);
  });

  it("a browser without Web Locks cannot tell, so it plays", async () => {
    const l = await acquireSubmitterLock("m-1", "acct", undefined);
    expect(l.held).toBe(true);
  });
});
