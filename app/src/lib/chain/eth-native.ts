import { type Address } from "viem";
import { parseAbi } from "viem";
import { OPEN_GAS_UNITS } from "./eth-fee";

/**
 * Opening with the plain coin (ADR 0011): ETH is staked through Lido and HYPE through Kinetiq's StakingManager by a
 * zap contract (contracts/src/StakeZap.sol) in the same transaction that opens the Position, so the Player signs
 * once and any failure reverts the whole call. Never a DEX swap.
 *
 * Sources: Lido wstETH `receive()` stakes ETH and mints wstETH (docs.lido.fi/contracts/wsteth); Kinetiq StakingManager
 * 0x393D0B87Ed38fc779FD9611144aE649BA6082109 `stake()` payable, minimum `minStakeAmount()` (5 HYPE on 2026-10-15)
 * (kinetiq.xyz/docs/contracts-and-audits, read on chain).
 */

export const zapAbi = parseAbi([
  "function openWithNative(uint256 stakeAmount, uint256 minLst, uint8 horizonMonths) payable returns (uint64 id, uint256 lstAmount)",
]);
export const kinetiqZapAbi = parseAbi(["function minStake() view returns (uint256)"]);
export const rateSourceAbi = parseAbi(["function rateSource() view returns (address)", "function underlyingPerShare() view returns (uint256)"]);

export type OpenWith = "native" | "token";

export interface OpenChoice {
  with: OpenWith;
  symbol: string;
}

/** "ETH" / "wstETH" or "HYPE" / "kHYPE": the coin first, only when the vault has a zap. */
export function openChoices(vault: { symbol: string; zap?: Address }, native: "ETH" | "HYPE"): OpenChoice[] {
  const token: OpenChoice = { with: "token", symbol: vault.symbol };
  return vault.zap ? [{ with: "native", symbol: native }, token] : [token];
}

/** Slippage the Player accepts between the quote and the block the stake lands in (the rate moves once a day). */
export const STAKE_SLIPPAGE_BPS = 50n;

export interface NativeQuote {
  /** LST received for the stake at the current rate (rounded down). */
  lstOut: bigint;
  /** The least the zap accepts; below it the whole call reverts. */
  minLst: bigint;
  /** Principal the vault records: lstOut priced at the rate. */
  principalWei: bigint;
  /** Kinetiq refuses stakes under its minimum; Lido has none. */
  belowMinimum: boolean;
}

/** `rate` is underlying per LST share, 1e18-scaled (the vault's rate source). */
export function quoteNativeStake(input: { stakeWei: bigint; rate: bigint; minStakeWei?: bigint; slippageBps?: bigint }): NativeQuote {
  const { stakeWei, rate } = input;
  if (stakeWei <= 0n || rate <= 0n) return { lstOut: 0n, minLst: 0n, principalWei: 0n, belowMinimum: false };
  const lstOut = (stakeWei * 10n ** 18n) / rate;
  const minLst = (lstOut * (10_000n - (input.slippageBps ?? STAKE_SLIPPAGE_BPS))) / 10_000n;
  return { lstOut, minLst, principalWei: (lstOut * rate) / 10n ** 18n, belowMinimum: stakeWei < (input.minStakeWei ?? 0n) };
}

/** msg.value of the zap call: the coin to stake plus the LayerZero fee (the excess fee is refunded). */
export const nativeOpenValue = (stakeWei: bigint, lzFeeWei: bigint) => stakeWei + lzFeeWei;

/** Gas allowance of the zap call: stake + approve inside + `openPositionFor` + the LayerZero send. No separate approve transaction. */
export const NATIVE_OPEN_GAS = OPEN_GAS_UNITS.open + 300_000n;

/** Plain message for a stake the provider would refuse, shown before signing. */
export function nativeStakeProblem(q: NativeQuote, minStakeWei: bigint | undefined, symbol: string): string | null {
  if (q.belowMinimum && minStakeWei) return `The smallest ${symbol} stake is ${Number(minStakeWei) / 1e18} ${symbol}.`;
  return null;
}
