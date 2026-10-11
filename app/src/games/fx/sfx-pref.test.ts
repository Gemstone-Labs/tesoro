import { describe, expect, it } from "vitest";
import { readMuted, writeMuted } from "./sfx-pref";

const store = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [["tesoro.sfx", initial]]);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("sound preference", () => {
  it("is on by default", () => {
    expect(readMuted(store())).toBe(false);
    expect(readMuted(null)).toBe(false);
  });
  it("remembers the choice", () => {
    const s = store();
    writeMuted(true, s);
    expect(readMuted(s)).toBe(true);
    writeMuted(false, s);
    expect(readMuted(s)).toBe(false);
  });
  it("survives storage throwing", () => {
    expect(readMuted(throwing)).toBe(false);
    expect(() => writeMuted(true, throwing)).not.toThrow();
  });
});
