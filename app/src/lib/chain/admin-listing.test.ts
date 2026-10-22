import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { listGameIx } from "./admin-listing";
import { gameRecordPda, programDataPda } from "./game-record";
import { CORE_PROGRAM_ID } from "./core-ix";

describe("list_game from the admin wallet", () => {
  const admin = Keypair.generate().publicKey;
  const program = Keypair.generate().publicKey;
  const hash = "ab".repeat(32);

  it("names the Game record, program and ProgramData, with the admin signing", () => {
    const ix = listGameIx(admin, program, 1_900_000_000, hash);
    expect(ix.programId.equals(CORE_PROGRAM_ID)).toBe(true);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(gameRecordPda(program).toBase58());
    expect(keys).toContain(program.toBase58());
    expect(keys).toContain(programDataPda(program).toBase58());
    expect(ix.keys.find((k) => k.pubkey.equals(admin))?.isSigner).toBe(true);
  });
  it("carries the time and the 32 hash bytes in its data", () => {
    const ix = listGameIx(admin, program, 1_900_000_000, hash);
    const data = Buffer.from(ix.data);
    expect(data.readBigInt64LE(8)).toBe(1_900_000_000n);
    expect(data.subarray(16, 48).toString("hex")).toBe(hash);
    expect(data.length).toBe(48);
  });
  it("refuses a malformed hash", () => {
    expect(() => listGameIx(admin, program, 1, "xyz")).toThrow(/64 hex/);
  });
});
