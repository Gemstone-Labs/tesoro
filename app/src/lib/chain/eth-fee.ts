import { CLUSTER, type ClusterSettings } from "@/lib/cluster-settings";
import { LZ_FEE_HEADROOM_PCT } from "./eth";

/**
 * Cost of opening an EVM Position, shown before the Player signs. On the mainnet cluster the Player pays the
 * gas and the LayerZero fee and the relayer sends nothing on the EVM side; in test mode the relayer tops the
 * wallet up (src/lib/chain/eth-flow.ts `ensureGas`).
 */

/** Gas allowances for the two transactions (a wstETH approve and `openPosition` incl. the LayerZero send). */
export const OPEN_GAS_UNITS = { approve: 60_000n, open: 350_000n } as const;

export interface OpenCostQuote {
  /** Gas units for the transactions the Player signs. */
  gasUnits: bigint;
  gasPriceWei: bigint;
  /** Estimated network fee: gasUnits * gasPriceWei. */
  gasWei: bigint;
  /** LayerZero fee sent as msg.value: the vault's quote plus headroom (the vault refunds the excess). */
  lzFeeWei: bigint;
  /** What the Player needs in the native token, besides any ETH they lock. */
  totalWei: bigint;
}

export const playerPaysGas = (cluster: ClusterSettings = CLUSTER) => cluster.id === "mainnet";

export function quoteOpenCost(input: { lzQuoteWei: bigint; gasPriceWei: bigint; needsApprove: boolean }): OpenCostQuote {
  const gasUnits = OPEN_GAS_UNITS.open + (input.needsApprove ? OPEN_GAS_UNITS.approve : 0n);
  const gasWei = gasUnits * input.gasPriceWei;
  const lzFeeWei = (input.lzQuoteWei * (100n + LZ_FEE_HEADROOM_PCT)) / 100n;
  return { gasUnits, gasPriceWei: input.gasPriceWei, gasWei, lzFeeWei, totalWei: gasWei + lzFeeWei };
}

/** Throws a plain message when the wallet cannot cover the quote; `balanceWei` is what is left after any locked native amount. */
export function assertCanAffordOpen(balanceWei: bigint, quote: OpenCostQuote, symbol: string): void {
  if (balanceWei >= quote.totalWei) return;
  const need = Number(quote.totalWei) / 1e18;
  throw new Error(`You need about ${need.toFixed(need < 0.01 ? 5 : 4)} ${symbol} in your wallet for gas and the cross-chain fee.`);
}
