"use client";

import { useEffect, useState } from "react";
import { redeemCost, type RedeemCost } from "./ready-by";

/** The cross-chain fee of paying a Redeem out on ETH or HYPE, in lamports; null while unknown or unavailable. Cached per tab for a minute. */
const cache = new Map<string, { at: number; fee: bigint | null }>();

export async function fetchRedeemFee(asset: "ETH" | "HYPE", doFetch: typeof fetch = (...a) => fetch(...a)): Promise<bigint | null> {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < 60_000) return hit.fee;
  let fee: bigint | null = null;
  try {
    const res = await doFetch(`/api/eth-bridge?quote=redeem&asset=${asset}`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) fee = BigInt(((await res.json()) as { feeLamports: string }).feeLamports);
  } catch {
    fee = null;
  }
  cache.set(asset, { at: Date.now(), fee });
  return fee;
}

/** What redeeming `redeemGemas` of `asset` costs in fees, or null while the quote is unknown. ETH and HYPE only; SOL pays nothing extra. */
export function useRedeemCost(asset: "SOL" | "ETH" | "HYPE", redeemGemas: number, solMicroUsd: bigint | null | undefined): RedeemCost | null {
  const [fee, setFee] = useState<bigint | null>(null);
  useEffect(() => {
    if (asset === "SOL" || redeemGemas <= 0) return;
    let alive = true;
    void fetchRedeemFee(asset).then((f) => alive && setFee(f));
    return () => {
      alive = false;
    };
  }, [asset, redeemGemas]);
  if (asset === "SOL" || redeemGemas <= 0 || fee === null || !solMicroUsd) return null;
  return redeemCost({ feeLamports: fee, solMicroUsd, redeemGemas: BigInt(Math.floor(redeemGemas)) });
}
