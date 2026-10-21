import { describe, expect, it } from "vitest";
import { duelMatchId, assetOfMatchId } from "../../games/trading-duel/chain";
import { assetIndexFromParam, assetIndexOf, matchOpenedAt } from "./match-id";
import { newMatchId, isChallengeId } from "./match-flow";
import { gameFromParam, gameQuery } from "../game-params";

const MS = 1_790_000_000_000;

describe("Match ids", () => {
  it("Block Burst and Hold'em ids are ms * 2 + challenge; their opening time reads back", () => {
    const id = BigInt(MS) * 2n + 1n;
    expect(matchOpenedAt(id, "holdem")).toBe(MS);
    expect(matchOpenedAt(id, "block-puzzle")).toBe(MS);
  });

  it("a Vanguard id is ms * 2 + challenge, with no asset in it", () => {
    for (const challenge of [false, true]) {
      const id = newMatchId(challenge, "vanguard");
      expect(isChallengeId(id)).toBe(challenge);
      expect(Math.abs(matchOpenedAt(id, "vanguard") - Date.now())).toBeLessThan(5_000);
    }
  });

  it("a Trading Duel id is ms * 8 + asset * 2 + challenge", () => {
    for (const asset of [0, 1, 2] as const) {
      for (const challenge of [false, true]) {
        const id = duelMatchId(asset, challenge, MS);
        expect(id).toBe(BigInt(MS) * 8n + BigInt(asset) * 2n + (challenge ? 1n : 0n));
        expect(assetIndexOf(id)).toBe(asset);
        expect(assetOfMatchId(id)?.id).toBe(asset);
        expect(isChallengeId(id)).toBe(challenge);
        expect(matchOpenedAt(id, "trading-duel")).toBe(MS);
      }
    }
  });

  it("newMatchId keeps the old formula for the other Games and encodes the asset for Trading Duel", () => {
    const bp = newMatchId(false, "block-puzzle");
    expect(bp % 2n).toBe(0n);
    const td = newMatchId(true, "trading-duel", 2);
    expect(assetIndexOf(td)).toBe(2);
    expect(isChallengeId(td)).toBe(true);
  });

  it("the asset query value maps to an index and unknown values are SOL", () => {
    expect(assetIndexFromParam("eth")).toBe(1);
    expect(assetIndexFromParam("HYPE")).toBe(2);
    expect(assetIndexFromParam("doge")).toBe(0);
    expect(assetIndexFromParam(undefined)).toBe(0);
  });

  it("play links carry the game and the asset", () => {
    expect(gameQuery("block-puzzle")).toBe("");
    expect(gameQuery("holdem")).toBe("game=holdem&");
    expect(gameQuery("trading-duel", 1)).toBe("game=trading-duel&asset=eth&");
    expect(gameFromParam("trading-duel")).toBe("trading-duel");
    expect(gameFromParam("nope")).toBe("block-puzzle");
  });
});
