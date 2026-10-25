import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { GAME_IDS, gameOfProgram } from "./games";
import { gameOf } from "./read";
import { GAME_IDS as flowIds } from "./match-flow";

describe("Game <-> program id", () => {
  it("maps every Game's program back to that Game, in the app and the keeper's shared table alike", () => {
    for (const [game, id] of Object.entries(GAME_IDS)) {
      expect(gameOfProgram(id)).toBe(game);
      expect(gameOf(id)).toBe(game);
      expect(flowIds[game as keyof typeof flowIds]).toBe(id);
    }
  });

  it("has one program per Game and knows no other", () => {
    expect(new Set(Object.values(GAME_IDS).map((k) => k.toBase58())).size).toBe(Object.keys(GAME_IDS).length);
    expect(gameOfProgram(PublicKey.default)).toBeNull();
  });
});
