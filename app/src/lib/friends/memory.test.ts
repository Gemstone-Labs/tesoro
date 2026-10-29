import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLinks, loadLink, readShape, rememberedLink, replaceLink, writeShape } from "./memory";

beforeEach(() => forgetLinks());

describe("Friend link memory", () => {
  it("fetches once; a second visit reuses it", async () => {
    const fetchCode = vi.fn(async () => "abc");
    expect(await loadLink("me", fetchCode)).toBe("abc");
    expect(await loadLink("me", fetchCode)).toBe("abc");
    expect(fetchCode).toHaveBeenCalledTimes(1);
    expect(rememberedLink("me")).toBe("abc");
  });
  it("shares one fetch between two mounts at the same time", async () => {
    const fetchCode = vi.fn(async () => "abc");
    await Promise.all([loadLink("me", fetchCode), loadLink("me", fetchCode)]);
    expect(fetchCode).toHaveBeenCalledTimes(1);
  });
  it("keeps one link per Account", async () => {
    await loadLink("ana", async () => "a1");
    expect(await loadLink("ben", async () => "b1")).toBe("b1");
  });
  it("Reset link replaces the remembered code", async () => {
    await loadLink("me", async () => "old");
    expect(await replaceLink("me", async () => "new")).toBe("new");
    expect(await loadLink("me", async () => "never")).toBe("new");
  });
  it("does not remember a failed fetch", async () => {
    await expect(loadLink("me", async () => Promise.reject(new Error("x")))).rejects.toThrow();
    expect(await loadLink("me", async () => "ok")).toBe("ok");
  });
});

describe("Friends shape memory", () => {
  it("is empty without storage", () => {
    expect(readShape("me")).toEqual({});
    expect(() => writeShape("me", { a: true })).not.toThrow();
  });
  it("keeps chips flags and drops Friends that are gone", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    writeShape("me", { a: true, b: false });
    writeShape("me", {}, ["a", "c"]);
    expect(readShape("me")).toEqual({ a: true, c: false });
    vi.unstubAllGlobals();
  });
});
