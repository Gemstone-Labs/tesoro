import { afterEach, describe, expect, it, vi } from "vitest";
import { filterByLease, freshLeases, keepScreenAwake, startPresenceLoop } from "./presence";

const reply = (body: unknown, ok = true) => vi.fn(async (...args: unknown[]) => (void args, ({ ok, json: async () => body }) as Response));

describe("presence client", () => {
  it("returns the fresh set", async () => {
    const f = reply({ fresh: ["a-1"] });
    expect(await freshLeases(["a-1", "b-2"], f as unknown as typeof fetch)).toEqual(new Set(["a-1"]));
    expect(f.mock.calls[0][0]).toBe("/api/queue/presence?ids=a-1,b-2");
  });
  it("is null when the call fails, so nothing is filtered", async () => {
    expect(await freshLeases(["a-1"], reply({}, false) as unknown as typeof fetch)).toBeNull();
    expect(await freshLeases(["a-1"], (async () => { throw new Error("x"); }) as unknown as typeof fetch)).toBeNull();
    expect(await freshLeases(["a-1"], reply({ nope: 1 }) as unknown as typeof fetch)).toBeNull();
    expect(filterByLease(["a-1", "b-2"], null)).toEqual(["a-1", "b-2"]);
  });
  it("asks nothing for no ids and filters by the set", async () => {
    const f = reply({ fresh: [] });
    expect(await freshLeases([], f as unknown as typeof fetch)).toEqual(new Set());
    expect(f).not.toHaveBeenCalled();
    expect(filterByLease(["a-1", "b-2"], new Set(["b-2"]))).toEqual(["b-2"]);
  });
});

describe("startPresenceLoop", () => {
  afterEach(() => vi.useRealTimers());
  it("touches at once and every 15 s, survives a failure, and stops when asked", () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => {
      throw new Error("down");
    });
    const stop = startPresenceLoop(touch);
    expect(touch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(touch).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(touch).toHaveBeenCalledTimes(3);
  });
});

function fakePage(state: "visible" | "hidden" = "visible") {
  const handlers = new Set<() => void>();
  return {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (_: string, h: () => void) => handlers.add(h),
    removeEventListener: (_: string, h: () => void) => handlers.delete(h),
    show() {
      this.visibilityState = "visible";
      handlers.forEach((h) => h());
    },
    hide() {
      this.visibilityState = "hidden";
      handlers.forEach((h) => h());
    },
    handlers,
  };
}

describe("a Player who comes back to the page", () => {
  afterEach(() => vi.useRealTimers());
  it("touches the lease on return instead of waiting for the next tick, and stops listening when stopped", () => {
    vi.useFakeTimers();
    const page = fakePage();
    const touch = vi.fn(async () => undefined);
    const stop = startPresenceLoop(touch, 15_000, page as never);
    page.hide();
    expect(touch).toHaveBeenCalledTimes(1);
    page.show();
    expect(touch).toHaveBeenCalledTimes(2);
    stop();
    expect(page.handlers.size).toBe(0);
  });

  it("holds the screen awake while waiting, takes the lock again after the page was hidden, and lets go", async () => {
    const released = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release: released }));
    const page = fakePage();
    const stop = keepScreenAwake({ wakeLock: { request } }, page as never);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    page.hide();
    expect(request).toHaveBeenCalledTimes(1);
    page.show();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    stop();
    await Promise.resolve();
    expect(released).toHaveBeenCalled();
    expect(page.handlers.size).toBe(0);
  });

  it("does nothing where the browser has no Wake Lock", () => {
    expect(() => keepScreenAwake({}, fakePage() as never)()).not.toThrow();
  });
});
