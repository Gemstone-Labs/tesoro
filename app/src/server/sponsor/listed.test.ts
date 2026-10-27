import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { gameIsListed } from "./listed";

const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const key = () => PublicKey.unique();
const NOW = 1_800_000_000;
const record = async (over: { listed_until?: number; approved_slot?: number } = {}) =>
  Buffer.from(
    await coder.encode("GameRecord", {
      bump: 1, game: key(), settle_authority: key(), studio_bps: 0, studio_recipient: key(), pending_at: new BN(0), pending_by: key(),
      pending_settle_authority: key(), pending_studio_bps: 0, pending_studio_recipient: key(), listed_until: new BN(over.listed_until ?? NOW + 100),
      approved_slot: new BN(over.approved_slot ?? 77), approved_hash: new Array(32).fill(1), listing_epoch: 1,
    }),
  );
/** An upgradeable-loader ProgramData account: tag u32, then the deploy slot u64. */
const programData = (slot: number) => {
  const d = Buffer.alloc(45);
  d.writeUInt32LE(3, 0);
  d.writeBigUInt64LE(BigInt(slot), 4);
  return d;
};

describe("a Game counts as listed for the sponsor", () => {
  it("while the listing runs and the deployed build is the approved one", async () => {
    expect(gameIsListed(await record(), programData(77), NOW)).toBe(true);
  });
  it("not after the listing ends, and not after an upgrade moved the deploy slot", async () => {
    expect(gameIsListed(await record({ listed_until: NOW - 1 }), programData(77), NOW)).toBe(false);
    expect(gameIsListed(await record(), programData(78), NOW)).toBe(false);
  });
  it("not when the program data is too short to hold a slot", async () => {
    expect(gameIsListed(await record(), Buffer.alloc(8), NOW)).toBe(false);
  });
});
