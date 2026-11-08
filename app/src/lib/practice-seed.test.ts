import { afterEach, describe, expect, it, vi } from "vitest";

async function load(dev: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET", dev ? "1" : "");
  return (await import("./practice-seed")).practiceSeed;
}

describe("practiceSeed", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads ?seed= in dev builds", async () => {
    const practiceSeed = await load(true);
    expect(practiceSeed("seed=7")).toBe(7);
    expect(practiceSeed("game=holdem&seed=42")).toBe(42);
  });

  it("ignores a missing or non-integer seed", async () => {
    const practiceSeed = await load(true);
    expect(practiceSeed("")).toBeUndefined();
    expect(practiceSeed("seed=abc")).toBeUndefined();
    expect(practiceSeed("seed=1.5")).toBeUndefined();
  });

  it("ignores the seed outside dev builds", async () => {
    const practiceSeed = await load(false);
    expect(practiceSeed("seed=7")).toBeUndefined();
  });
});
