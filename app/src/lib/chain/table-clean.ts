import { PublicKey } from "@solana/web3.js";
import { settledPda } from "./basket";

/** `begin_match` cleans the table it starts (keeper diet 09): the receipts it needs are passed as remaining accounts. */

interface TableEpoch {
  generation: number;
  index: number;
  epoch: number;
}

interface RingSlot {
  state: number;
  tesoroMatch: PublicKey;
}

const SLOT_FREE = 0;

/**
 * The Assignment is one epoch ahead of its table: the previous Match settled and the table has not been reset yet.
 * `begin_match` resets it (once its last receipt is 30 s old), so the page calls it instead of waiting for a keeper.
 */
export function atNextEpoch(assignment: TableEpoch, table: TableEpoch): boolean {
  return assignment.generation === table.generation && assignment.index === table.index && assignment.epoch === table.epoch + 1;
}

/**
 * The settlement receipts `begin_match` may use: the receipt of the Match the table holds (it voids a table stuck on a
 * Match tesoro_core froze) and, when the ring has no free slot, the receipt of each slot's Match (it frees the ones
 * that are a minute old). A receipt that does not exist yet is simply not used.
 */
export function beginSettled(table: { tesoroMatch: PublicKey; ring: readonly RingSlot[] }): PublicKey[] {
  const matches = new Map<string, PublicKey>();
  if (!table.tesoroMatch.equals(PublicKey.default)) matches.set(table.tesoroMatch.toBase58(), table.tesoroMatch);
  if (table.ring.length > 0 && table.ring.every((s) => s.state !== SLOT_FREE)) {
    for (const s of table.ring) matches.set(s.tesoroMatch.toBase58(), s.tesoroMatch);
  }
  return [...matches.values()].map(settledPda);
}

/**
 * What the page says while it begins a Match on a table that still holds the previous one. A table that is already
 * finished is being cleared (wiped, committed, reset) before the Match starts; one that is not yet finished is being
 * given up first. Either way the page keeps retrying `begin_match`, so the line says what is happening, not "stuck".
 */
export const startNote = (tableFinished: boolean): string => (tableFinished ? "Clearing the table, then starting your Match" : "Starting the Match");

/** The remaining accounts of a `begin_match` call. */
export const receiptMetas = (receipts: readonly PublicKey[]) => receipts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
