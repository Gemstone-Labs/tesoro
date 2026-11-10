import { DEV_WALLET } from "@/lib/chain/config";

/**
 * A fixed seed for Practice from `?seed=<number>`, so recordings repeat. Dev builds only
 * (NEXT_PUBLIC_DEV_WALLET=1); real builds ignore the parameter and shuffle at random.
 */
export function practiceSeed(search?: string): number | undefined {
  if (!DEV_WALLET) return undefined;
  const raw = new URLSearchParams(search ?? (typeof window === "undefined" ? "" : window.location.search)).get("seed");
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}
