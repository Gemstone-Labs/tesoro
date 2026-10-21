// Storybook: the cross-chain fee of paying a Redeem out is a fixed quote (0.002 SOL at $150), so the small-Redeem note can be seen.
import type { RedeemCost } from "../../../../../src/lib/chain/ready-by";
import { redeemCost } from "../../../../../src/lib/chain/ready-by";

export const fetchRedeemFee = async () => 2_000_000n as bigint | null;

export function useRedeemCost(asset: "SOL" | "ETH" | "HYPE", redeemGemas: number): RedeemCost | null {
  if (asset === "SOL" || redeemGemas <= 0) return null;
  return redeemCost({ feeLamports: 2_000_000n, solMicroUsd: 150_000_000n, redeemGemas: BigInt(Math.floor(redeemGemas)) });
}
