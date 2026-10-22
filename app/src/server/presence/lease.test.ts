import { describe, expect, it } from "vitest";
import { LEASE_FRESH_MS, MemoryPresenceStore, PRESENCE_EVERY_MS, freshKeys, parseIds } from "./lease";

const NOW = 1_800_000_000_000;
const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();

describe("lease", () => {
  it("touches twice inside one lease", () => expect(PRESENCE_EVERY_MS * 2).toBeLessThanOrEqual(LEASE_FRESH_MS));
  it("keeps rows younger than 30 s and drops older ones", () => {
    const rows = [
      { match_key: "a-1", seen_at: at(0) },
      { match_key: "b-2", seen_at: at(29_999) },
      { match_key: "c-3", seen_at: at(30_000) },
      { match_key: "d-4", seen_at: at(120_000) },
    ];
    expect(freshKeys(rows, NOW)).toEqual(["a-1", "b-2"]);
  });
  it("parses ids: distinct, at most 100, never empty", () => {
    expect(parseIds("a-1, b-2,a-1")).toEqual(["a-1", "b-2"]);
    expect(parseIds(null)).toBeNull();
    expect(parseIds(",")).toBeNull();
    expect(parseIds(Array.from({ length: 101 }, (_, i) => `k-${i}`).join(","))).toBeNull();
    expect(parseIds(Array.from({ length: 100 }, (_, i) => `k-${i}`).join(","))).toHaveLength(100);
  });
  it("the memory store returns only rows it has", async () => {
    const s = new MemoryPresenceStore();
    await s.touch("a-1", at(0));
    expect(await s.rows(["a-1", "x-9"])).toEqual([{ match_key: "a-1", seen_at: at(0) }]);
  });
});
