import { describe, expect, it } from "vitest";
import { resolveViewMode, saveViewMode } from "./use-view-mode";
import { writeViewMode } from "./view-mode";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("view mode of an Account", () => {
  it("starts in Simple however the Player signed in", () => {
    expect(resolveViewMode("A", memory())).toBe("simple");
  });

  it("uses the default while signed out", () => {
    expect(resolveViewMode(null, memory())).toBe("simple");
  });

  it("prefers what the Player chose, per Account", () => {
    const store = memory();
    writeViewMode("A", "advanced", store);
    writeViewMode("B", "simple", store);
    expect(resolveViewMode("A", store)).toBe("advanced");
    expect(resolveViewMode("B", store)).toBe("simple");
    expect(resolveViewMode("C", store)).toBe("simple");
  });

  it("keeps a choice made before the Account's wallet key is known (the switch must not snap back)", () => {
    const store = memory();
    saveViewMode(null, "advanced", store);
    expect(resolveViewMode(null, store)).toBe("advanced");
    saveViewMode(null, "simple", store);
    expect(resolveViewMode(null, store)).toBe("simple");
  });

  it("keeps the choice for this visit when the browser blocks storage", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    saveViewMode("D", "advanced", blocked);
    expect(resolveViewMode("D", blocked)).toBe("advanced");
    expect(resolveViewMode("E", blocked)).toBe("simple");
  });
});
