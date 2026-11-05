import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { RAILCAR_PROGRAM_ID } from "@/games/railcar/chain";
import { GAME_IDS } from "@/lib/chain/games";
import { backedEntries, backedGameName, backedGameOf, backedGames, backedProgram } from "./games";

describe("the Games a Request can name: every listed head-to-head Game, and Railcar where it is shown", () => {
  it("reads Railcar's program as Railcar only where Railcar is shown", () => {
    expect(backedGameOf(RAILCAR_PROGRAM_ID, true)).toBe("railcar");
    expect(backedGameOf(RAILCAR_PROGRAM_ID, false)).toBeNull();
    expect(backedGameOf(GAME_IDS.holdem, false)).toBe("holdem");
    expect(backedGameOf(Keypair.generate().publicKey, true)).toBeNull();
  });

  it("a Railcar Request is for its one entry, 500 Gemas, and names Railcar's program", () => {
    expect(backedEntries("railcar")).toEqual([500]);
    expect(backedEntries("holdem")).toBeNull();
    expect(backedProgram("railcar").equals(RAILCAR_PROGRAM_ID)).toBe(true);
    expect(backedProgram("vanguard").equals(GAME_IDS.vanguard)).toBe(true);
    expect(backedGameName("railcar")).toBe("Railcar");
    expect(backedGameName("holdem")).toBe("Buckshot Hold'em");
  });

  it("lists Railcar after the head-to-head Games only where it is shown", () => {
    expect(backedGames(true).at(-1)).toBe("railcar");
    expect(backedGames(false)).not.toContain("railcar");
  });
});
