import { describe, expect, it } from "vitest";
import { BUSY } from "@/lib/errors";
import { ReadHealth } from "./read-health";

const raw429 = new Error('429 : {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}, "id": "dda6171b" }');

describe("ReadHealth: the page's chain reads fail and recover", () => {
  it("shows nothing for one failed read, then a plain sentence (no JSON) while reads keep failing", () => {
    const h = new ReadHealth();
    h.failed(raw429);
    expect(h.problem()).toBeNull();
    h.failed(raw429);
    expect(h.problem()).toBe(BUSY);
    expect(h.problem()).not.toMatch(/jsonrpc|429|\{/);
  });

  it("clears after a later successful read", () => {
    const h = new ReadHealth();
    h.failed(raw429);
    h.failed(raw429);
    h.succeeded();
    expect(h.problem()).toBeNull();
    h.failed(raw429);
    expect(h.problem()).toBeNull();
  });

  it("backs off while failing, up to a cap, and returns to the normal pace on success", () => {
    const h = new ReadHealth();
    expect(h.delay(800)).toBe(800);
    h.failed(raw429);
    expect(h.delay(800)).toBe(1_600);
    h.failed(raw429);
    expect(h.delay(800)).toBe(3_200);
    for (let i = 0; i < 20; i++) h.failed(raw429);
    expect(h.delay(800)).toBe(10_000);
    h.succeeded();
    expect(h.delay(800)).toBe(800);
  });

  it("any transient failure reads as busy: 5xx, timeouts, network errors", () => {
    for (const msg of ["503 Service Unavailable", "request timed out", "TypeError: Failed to fetch", "fetch failed"]) {
      const h = new ReadHealth();
      h.failed(new Error(msg));
      h.failed(new Error(msg));
      expect(h.problem(), msg).not.toBeNull();
      expect(h.problem(), msg).not.toContain(msg);
    }
  });
});
