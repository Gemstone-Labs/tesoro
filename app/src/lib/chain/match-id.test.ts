import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { matchPda } from "./basket";
import { ASSET_PARAMS, assetIndexFromParam, matchAddressOf, matchKeyOf, parseMatchKey } from "./match-id";
import { sessionOf } from "./game-accounts";
import { gameFromParam, gameQuery } from "../game-params";

describe("Match keys", () => {
  const opener = Keypair.generate().publicKey;

  it("a Match is its opener's Account and the opener's counter, `<opener>-<n>`", () => {
    const key = matchKeyOf({ opener: opener.toBase58(), n: 12n });
    expect(key).toBe(`${opener.toBase58()}-12`);
    expect(parseMatchKey(key)).toEqual({ opener: opener.toBase58(), n: 12n });
  });

  it("names the MatchState PDA the program derives from the same two numbers", () => {
    expect(matchAddressOf(`${opener.toBase58()}-12`)?.equals(matchPda(opener, 12n))).toBe(true);
    expect(matchAddressOf(`${opener.toBase58()}-13`)?.equals(matchPda(opener, 12n))).toBe(false);
  });

  it("refuses anything that is not a Match key (old numeric ids, padded counters, junk)", () => {
    for (const bad of ["3585151916926", "", "-5", `${opener.toBase58()}-`, `${opener.toBase58()}-05`, `${opener.toBase58()}-x`, "short-1"]) {
      expect(parseMatchKey(bad)).toBeNull();
      expect(matchAddressOf(bad)).toBeNull();
    }
  });

  it("Block Burst keys its Session by the tesoro_core Match address, so no two Matches share one", () => {
    const a = matchPda(opener, 1n);
    const b = matchPda(opener, 2n);
    expect(sessionOf(a).equals(sessionOf(b))).toBe(false);
    expect(sessionOf(a).equals(sessionOf(a))).toBe(true);
  });
});

describe("asset params", () => {
  it("maps ?asset= to an asset index, SOL for anything unknown", () => {
    expect(ASSET_PARAMS).toEqual(["sol", "eth", "hype"]);
    expect(assetIndexFromParam("eth")).toBe(1);
    expect(assetIndexFromParam("HYPE")).toBe(2);
    expect(assetIndexFromParam("nope")).toBe(0);
    expect(assetIndexFromParam(undefined)).toBe(0);
    expect(assetIndexFromParam(["hype", "eth"])).toBe(2);
  });
});

describe("play links", () => {
  it("carry the game and the asset", () => {
    expect(gameQuery("block-puzzle")).toBe("");
    expect(gameQuery("holdem")).toBe("game=holdem&");
    expect(gameQuery("trading-duel", 1)).toBe("game=trading-duel&asset=eth&");
    expect(gameFromParam("trading-duel")).toBe("trading-duel");
    expect(gameFromParam("nope")).toBe("block-puzzle");
  });
});
