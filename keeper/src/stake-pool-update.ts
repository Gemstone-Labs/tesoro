import { parseStakePool } from "../../app/src/lib/chain/stake-pool.ts";
import type { Info } from "./supply.ts";

/** The instruction is built in the app (a Player's payout carries it too). */
export { updateStakePoolBalanceIx } from "../../app/src/lib/chain/stake-pool.ts";

/** Epoch of the pool's last balance update, or null when the account is not a stake pool. */
export function lastUpdateEpoch(pool: Info): bigint | null {
  return pool ? (parseStakePool(pool.data)?.lastUpdateEpoch ?? null) : null;
}

/** True when the pool must be updated before a payout in `epoch` (more than `slack` epochs behind). */
export const poolIsStale = (pool: Info, epoch: bigint, slack = 0n) => {
  const last = lastUpdateEpoch(pool);
  return last !== null && epoch > last + slack;
};
