import { describe, expect, it } from "vitest";
import { GpaInputError, parseQuery } from "./gpa";

const CORE = "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh";
const q = (s: string) => parseQuery(new URLSearchParams(s));

describe("gpa parseQuery", () => {
  it("accepts an allowed program with filters and a slice", () => {
    const r = q(`program=${CORE}&filter=s:120&filter=m:9:${CORE}&slice=0:8`);
    expect(r.filters).toEqual([{ dataSize: 120 }, { memcmp: { offset: 9, bytes: CORE } }]);
    expect(r.slice).toEqual({ offset: 0, length: 8 });
  });
  it("rejects unknown programs and malformed filters", () => {
    expect(() => q("program=11111111111111111111111111111111")).toThrow(GpaInputError);
    expect(() => q(`program=${CORE}&filter=m:9:0OIl`)).toThrow(GpaInputError);
    expect(() => q(`program=${CORE}&filter=x:1`)).toThrow(GpaInputError);
    expect(() => q(`program=${CORE}&slice=a:b`)).toThrow(GpaInputError);
    expect(() => q(`program=${CORE}` + "&filter=s:1".repeat(5))).toThrow(GpaInputError);
  });
});
