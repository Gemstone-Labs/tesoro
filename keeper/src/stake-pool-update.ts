import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { parseStakePool } from "../../app/src/lib/chain/stake-pool.ts";
import type { Info } from "./supply.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Instruction 7 of the SPL stake pool program. */
const UPDATE_STAKE_POOL_BALANCE = 7;
const VALIDATOR_LIST_AT = 98;

/** Epoch of the pool's last balance update, or null when the account is not a stake pool. */
export function lastUpdateEpoch(pool: Info): bigint | null {
  return pool ? (parseStakePool(pool.data)?.lastUpdateEpoch ?? null) : null;
}

/**
 * `UpdateStakePoolBalance` of the SPL stake pool program: anyone may send it. tesoro_core refuses a pool that is more
 * than one epoch stale, so every payout out of a stake custody wants a fresh one. It needs the validator list to be
 * current too (the pool's operators update that each epoch); when it is not, the transaction fails and the next pass tries again.
 */
export function updateStakePoolBalanceIx(pool: PublicKey, info: NonNullable<Info>): TransactionInstruction {
  const view = parseStakePool(info.data);
  if (!view) throw new Error(`${pool.toBase58()} is not a stake pool`);
  const program = info.owner;
  const withdraw = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], program)[0];
  const validatorList = new PublicKey(info.data.subarray(VALIDATOR_LIST_AT, VALIDATOR_LIST_AT + 32));
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: program,
    keys: [w(pool), r(withdraw), w(validatorList), r(view.reserveStake), w(view.managerFeeAccount), w(view.poolMint), r(TOKEN_PROGRAM)],
    data: Buffer.from([UPDATE_STAKE_POOL_BALANCE]),
  });
}

/** True when the pool must be updated before a payout in `epoch` (more than `slack` epochs behind). */
export const poolIsStale = (pool: Info, epoch: bigint, slack = 0n) => {
  const last = lastUpdateEpoch(pool);
  return last !== null && epoch > last + slack;
};
