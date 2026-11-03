import type { PublicKey } from "@solana/web3.js";
import { gameRecordPda, programDataPda } from "./game-record";

/**
 * Whether a Game is listed right now, read before `open_match` so a Match that cannot start is never opened.
 * It mirrors `GameRecord::is_listed` of tesoro_core: `listed_until` is ahead of the clock and the program was deployed in
 * the slot the admin approved. Only the bytes that decide it are read.
 */

/** `listed_until` (i64) and `approved_slot` (u64), 213 bytes into a GameRecord (state.rs; the layout is pinned by `GameRecord::SPACE`). */
export const GAME_LISTING_SLICE = { offset: 213, length: 16 } as const;
/** The deploy slot of an upgradeable program: bytes 4..12 of its ProgramData. */
export const PROGRAM_DATA_SLICE = { offset: 4, length: 8 } as const;

export type Listing = "listed" | "unlisted" | "upgraded";

/** `record` and `programData` are the slices above; null when the account does not exist. */
export function listingFrom(record: Uint8Array | null, programData: Uint8Array | null, now: number): Listing {
  if (!record || !programData) return "unlisted";
  const r = Buffer.from(record.buffer, record.byteOffset, record.byteLength);
  const listedUntil = r.readBigInt64LE(0);
  if (listedUntil <= BigInt(now)) return "unlisted";
  const approvedSlot = r.readBigUInt64LE(8);
  const deploySlot = Buffer.from(programData.buffer, programData.byteOffset, programData.byteLength).readBigUInt64LE(0);
  return deploySlot === approvedSlot ? "listed" : "upgraded";
}

type SliceReader = {
  getAccountInfo(key: PublicKey, config: { dataSlice: { offset: number; length: number } }): Promise<{ data: Uint8Array } | null>;
};

/** Throws a plain message when `game` is not listed; returns when it is. */
export async function assertGameListed(conn: SliceReader, game: PublicKey, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const [record, programData] = await Promise.all([
    conn.getAccountInfo(gameRecordPda(game), { dataSlice: GAME_LISTING_SLICE }),
    conn.getAccountInfo(programDataPda(game), { dataSlice: PROGRAM_DATA_SLICE }),
  ]);
  const listing = listingFrom(record?.data ?? null, programData?.data ?? null, now);
  if (listing === "unlisted") throw new Error("This Game isn't listed right now.");
  if (listing === "upgraded") throw new Error("This Game is being upgraded and is not open for new Matches right now. Try again later.");
}
