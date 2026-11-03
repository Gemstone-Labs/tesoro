import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { GAME_LISTING_SLICE, PROGRAM_DATA_SLICE, assertGameListed, listingFrom } from "./game-listing";
import { gameRecordPda, programDataPda } from "./game-record";

const NOW = 1_800_000_000;

/** The 16 bytes of a GameRecord from `listed_until`: i64 then `approved_slot`: u64. */
const recordSlice = (listedUntil: number, approvedSlot: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigInt64LE(BigInt(listedUntil), 0);
  b.writeBigUInt64LE(approvedSlot, 8);
  return b;
};
/** The 8 bytes of a ProgramData account from byte 4: the deploy slot. */
const slotSlice = (slot: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(slot, 0);
  return b;
};

describe("Listing in force", () => {
  it("is listed while listed_until is ahead and the program was deployed in the approved slot", () => {
    expect(listingFrom(recordSlice(NOW + 10, 77n), slotSlice(77n), NOW)).toBe("listed");
  });
  it("is not listed once listed_until has passed, or was never set", () => {
    expect(listingFrom(recordSlice(NOW - 1, 77n), slotSlice(77n), NOW)).toBe("unlisted");
    expect(listingFrom(recordSlice(0, 0n), slotSlice(77n), NOW)).toBe("unlisted");
  });
  it("is not listed when the program was deployed again since it was approved", () => {
    expect(listingFrom(recordSlice(NOW + 10, 77n), slotSlice(90n), NOW)).toBe("upgraded");
  });
  it("is unlisted when there is no record", () => {
    expect(listingFrom(null, slotSlice(1n), NOW)).toBe("unlisted");
  });
});

describe("assertGameListed", () => {
  const game = Keypair.generate().publicKey;
  const conn = (record: Buffer | null, data: Buffer | null) => {
    const asked: { key: string; offset: number; length: number }[] = [];
    return {
      asked,
      getAccountInfo: async (key: { toBase58(): string }, cfg: { dataSlice: { offset: number; length: number } }) => {
        asked.push({ key: key.toBase58(), ...cfg.dataSlice });
        const data_ = key.toBase58() === gameRecordPda(game).toBase58() ? record : data;
        return data_ ? { data: data_ } : null;
      },
    };
  };

  it("reads only the listing fields of the record and the deploy slot of the program", async () => {
    const c = conn(recordSlice(NOW + 10, 5n), slotSlice(5n));
    await assertGameListed(c, game, NOW);
    expect(c.asked).toEqual(
      expect.arrayContaining([
        { key: gameRecordPda(game).toBase58(), ...GAME_LISTING_SLICE },
        { key: programDataPda(game).toBase58(), ...PROGRAM_DATA_SLICE },
      ]),
    );
    expect(GAME_LISTING_SLICE).toEqual({ offset: 213, length: 16 });
    expect(PROGRAM_DATA_SLICE).toEqual({ offset: 4, length: 8 });
  });
  it("says in plain words that the Game is not listed, before any Match opens", async () => {
    await expect(assertGameListed(conn(recordSlice(NOW - 5, 5n), slotSlice(5n)), game, NOW)).rejects.toThrow("This Game isn't listed right now.");
    await expect(assertGameListed(conn(null, slotSlice(5n)), game, NOW)).rejects.toThrow("This Game isn't listed right now.");
  });
  it("names an upgraded Game", async () => {
    await expect(assertGameListed(conn(recordSlice(NOW + 5, 5n), slotSlice(6n)), game, NOW)).rejects.toThrow("being upgraded");
  });
});
