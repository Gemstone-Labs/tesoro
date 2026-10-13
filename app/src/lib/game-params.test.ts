import { describe, expect, it } from "vitest";
import { assetFromParam, backingQuery, challengeHref, gameFromParam } from "./game-params";

const parse = (q: string) => {
  const sp = new URLSearchParams(q);
  return { game: gameFromParam(sp.get("game") ?? undefined), asset: assetFromParam(sp.get("asset") ?? undefined), entry: Number(sp.get("entry")), backing: sp.get("backing") };
};

describe("backingQuery", () => {
  it("carries the asset of a Trading Duel Backing into the Queue link and back out", () => {
    for (const [asset, name] of [[0, "sol"], [1, "eth"], [2, "hype"]] as const) {
      const q = backingQuery("trading-duel", asset, 1000, "OFFER1");
      expect(q).toBe(`game=trading-duel&asset=${name}&entry=1000&backing=OFFER1`);
      expect(parse(q)).toEqual({ game: "trading-duel", asset, entry: 1000, backing: "OFFER1" });
    }
  });

  it("defaults to SOL, and other Games carry no asset", () => {
    expect(backingQuery("trading-duel", undefined, 500, "O")).toBe("game=trading-duel&asset=sol&entry=500&backing=O");
    expect(backingQuery("holdem", 2, 500, "O")).toBe("game=holdem&entry=500&backing=O");
    expect(backingQuery("block-puzzle", 1, 500, "O")).toBe("entry=500&backing=O");
    expect(assetFromParam("nonsense")).toBe(0);
  });
});

describe("challengeHref", () => {
  it("leads to the Challenge route of the Game at the default entry", () => {
    expect(challengeHref("block-puzzle")).toBe("/play/challenge");
    expect(challengeHref("holdem")).toBe("/play/challenge?game=holdem");
    expect(challengeHref("trading-duel", 1)).toBe("/play/challenge?game=trading-duel&asset=eth");
  });
});
