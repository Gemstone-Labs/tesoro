import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeListing, listGameIx } from "./admin-listing";
import coreIdl from "./idl/tesoro_core.json";
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

describe("a GameRecord's listing", () => {
  const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
  const k = () => Keypair.generate().publicKey;
  const record = (over: object) =>
    coder.encode("GameRecord", {
      bump: 1, game: k(), settle_authority: k(), studio_bps: 300, studio_recipient: k(), pending_at: new BN(0), pending_by: k(), pending_settle_authority: k(),
      pending_studio_bps: 0, pending_studio_recipient: k(), listed_until: new BN(1_900_000_000), approved_slot: new BN(518_610_621), approved_hash: Array(32).fill(0xab), listing_epoch: 2, ...over,
    });

  it("reads the bytes the real coder writes", async () => {
    expect(decodeListing(await record({}))).toEqual({ listedUntil: 1_900_000_000, approvedSlot: 518_610_621n, approvedHash: "ab".repeat(32) });
  });

  it("shows an all-zero hash as no approved build", async () => {
    expect(decodeListing(await record({ approved_hash: Array(32).fill(0) })).approvedHash).toBeNull();
  });
});
