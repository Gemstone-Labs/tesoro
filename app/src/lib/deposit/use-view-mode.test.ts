import { describe, expect, it } from "vitest";
import { resolveViewMode } from "./use-view-mode";
import { writeViewMode } from "./view-mode";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("view mode of an Account", () => {
  it("defaults by how the Player signed in", () => {
    const store = memory();
    expect(resolveViewMode("A", 0, store)).toBe("simple");
    expect(resolveViewMode("A", 1, store)).toBe("advanced");
  });

  it("uses the default while signed out", () => {
    expect(resolveViewMode(null, 0, memory())).toBe("simple");
  });

  it("prefers what the Player chose, per Account", () => {
    const store = memory();
    writeViewMode("A", "advanced", store);
    writeViewMode("B", "simple", store);
    expect(resolveViewMode("A", 0, store)).toBe("advanced");
    expect(resolveViewMode("B", 1, store)).toBe("simple");
    expect(resolveViewMode("C", 0, store)).toBe("simple");
  });
});
