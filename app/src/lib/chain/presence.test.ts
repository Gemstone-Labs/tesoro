import { afterEach, describe, expect, it, vi } from "vitest";
import { filterByLease, freshLeases, startPresenceLoop } from "./presence";

const reply = (body: unknown, ok = true) => vi.fn(async (..._a: unknown[]) => ({ ok, json: async () => body }) as Response);

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
