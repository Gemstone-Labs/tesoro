import { describe, expect, it } from "vitest";
import { readGemasQuery } from "./query";

const q = (s: string) => readGemasQuery(new URLSearchParams(s));

describe("readGemasQuery", () => {
  it("treats deposit=1 and open=1 the same", () => {
    expect(q("deposit=1").wanted).toBe(true);
    expect(q("open=1").wanted).toBe(true);
    expect(q("").wanted).toBe(false);
    expect(q("open=0").wanted).toBe(false);
  });
  it("reads the game and entry a game sent", () => {
    expect(q("open=1&game=holdem&need=500").intent).toEqual({ game: "holdem", need: 500 });
    expect(q("deposit=1&game=holdem").intent).toEqual({ game: "holdem", need: null });
  });
  it("ignores unknown games", () => {
    expect(q("open=1&game=nope&need=5").intent).toBeNull();
  });
});
