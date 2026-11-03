import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { isStale, parseStakePool, updateStakePoolBalanceIx, validatorListOf } from "./stake-pool";

/**
 * The stake pool update a Player's payout carries when the pool has fallen too far behind. Jito keeps the pool current in
 * practice, so this is empty almost always.
 */

/** A validator list is a 1-byte type, a u32 maximum and a u32 length; the entries follow. */
export const VALIDATOR_LIST_LEN_AT = 5;
export const VALIDATOR_LIST_ENTRIES_AT = 9;
/** One entry: stakes (2 x u64), `last_update_epoch` (u64), seeds (u64, u32, u32), status (u8), vote account (32). */
export const VALIDATOR_ENTRY_LEN = 73;
const ENTRY_EPOCH_AT = 16;

type Slice = { offset: number; length: number };
type PoolConn = {
  getAccountInfo(key: PublicKey, config?: { dataSlice?: Slice }): Promise<{ data: Uint8Array; owner: PublicKey } | null>;
  getEpochInfo(): Promise<{ epoch: number }>;
};

/**
 * True when the validator list was updated this epoch. The pool's operators update it in order, so the last entry is the
 * last to move: that entry and the list's length are all that is read.
 */
async function validatorListCurrent(conn: PoolConn, list: PublicKey, epoch: bigint): Promise<boolean> {
  const head = await conn.getAccountInfo(list, { dataSlice: { offset: VALIDATOR_LIST_LEN_AT, length: 4 } });
  if (!head || head.data.length < 4) return false;
  const count = Buffer.from(head.data).readUInt32LE(0);
  if (count === 0) return true;
  const offset = VALIDATOR_LIST_ENTRIES_AT + (count - 1) * VALIDATOR_ENTRY_LEN;
  const last = await conn.getAccountInfo(list, { dataSlice: { offset, length: VALIDATOR_ENTRY_LEN } });
  if (!last || last.data.length < VALIDATOR_ENTRY_LEN) return false;
  return Buffer.from(last.data).readBigUInt64LE(ENTRY_EPOCH_AT) >= epoch;
}

/**
 * `UpdateStakePoolBalance` for `pool`, to put before a payout out of its stake custody; empty when the pool is within the
 * lag tesoro_core accepts, when the pool cannot be read, or when the validator list is itself behind (the update would
 * fail, so the payout is left to show its own `StaleStakePool` message).
 */
export async function stakePoolRefreshIxs(conn: PoolConn, pool: PublicKey): Promise<TransactionInstruction[]> {
  const [info, { epoch }] = await Promise.all([conn.getAccountInfo(pool), conn.getEpochInfo()]);
  const view = info ? parseStakePool(info.data) : null;
  if (!info || !view || !isStale(view, epoch)) return [];
  if (!(await validatorListCurrent(conn, validatorListOf(info.data), BigInt(epoch)))) return [];
  return [updateStakePoolBalanceIx(pool, info)];
}
