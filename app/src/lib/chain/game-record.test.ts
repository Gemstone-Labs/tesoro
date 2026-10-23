import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { GAME_IDS } from "./games";
import { gameAccounts, gameRecordPda, pairPda, programDataPda, registerPda, UPGRADEABLE_LOADER } from "./game-record";
import { TESORO_CORE_ID } from "./native";

describe("Game record addresses", () => {
  it("derive per program, from the seeds tesoro_core uses", () => {
    const g = GAME_IDS.holdem;
    expect(gameRecordPda(g).equals(PublicKey.findProgramAddressSync([Buffer.from("game"), g.toBuffer()], TESORO_CORE_ID)[0])).toBe(true);
    expect(gameRecordPda(g).equals(gameRecordPda(GAME_IDS.vanguard))).toBe(false);
    expect(programDataPda(g).equals(PublicKey.findProgramAddressSync([g.toBuffer()], UPGRADEABLE_LOADER)[0])).toBe(true);
    expect(gameAccounts(g).gameProgram.equals(g)).toBe(true);
  });
  it("a pair is directional and the register PDA belongs to the Game program", () => {
    const [a, b] = [GAME_IDS.holdem, GAME_IDS.vanguard];
    expect(pairPda(a, b).equals(pairPda(b, a))).toBe(false);
    expect(registerPda(a).equals(PublicKey.findProgramAddressSync([Buffer.from("tesoro-register")], a)[0])).toBe(true);
  });
});
