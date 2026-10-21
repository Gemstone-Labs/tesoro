import { describe, expect, it } from "vitest";
import { defaultViewMode, getGemasHref, readViewMode, writeViewMode } from "./view-mode";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("view mode", () => {
  it("starts email sign-ins in Simple and own-wallet sign-ins in Advanced", () => {
    expect(defaultViewMode(0)).toBe("simple");
    expect(defaultViewMode(1)).toBe("advanced");
  });

  it("remembers the choice per Account", () => {
    const store = memory();
    expect(readViewMode("A", store)).toBeNull();
    writeViewMode("A", "advanced", store);
    expect(readViewMode("A", store)).toBe("advanced");
    expect(readViewMode("B", store)).toBeNull();
  });

  it("ignores junk and blocked storage", () => {
    const store = memory();
    store.setItem("tesoro:view:A", "pro");
    expect(readViewMode("A", store)).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readViewMode("A", blocked)).toBeNull();
    expect(() => writeViewMode("A", "simple", blocked)).not.toThrow();
  });

  it("sends Get Gemas to the packs in Simple and the Wallet sheet in Advanced", () => {
    expect(getGemasHref("simple")).toBe("/vault?deposit=1");
    expect(getGemasHref("advanced")).toBe("/wallet?open=1");
    expect(getGemasHref("simple", { game: "holdem", need: 500 })).toBe("/vault?deposit=1&need=500&game=holdem");
    expect(getGemasHref("advanced", { game: "holdem", need: null })).toBe("/wallet?open=1&game=holdem");
  });
});
