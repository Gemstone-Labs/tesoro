import { PublicKey } from "@solana/web3.js";
import type { AccountSnapshot } from "./read";

/**
 * The Account state as JSON between `/api/account/<authority>` and the browser: bigints as decimal
 * strings and keys as base58, tagged so they come back as the same types `AccountSnapshot` declares.
 */
export function encodeState(value: unknown): unknown {
  if (typeof value === "bigint") return { $big: value.toString() };
  if (value instanceof PublicKey) return { $key: value.toBase58() };
  if (Array.isArray(value)) return value.map(encodeState);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeState(v)]));
  return value;
}

export function decodeState<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map(decodeState) as T;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.$big === "string") return BigInt(o.$big) as T;
    if (typeof o.$key === "string") return new PublicKey(o.$key) as T;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decodeState(v)])) as T;
  }
  return value as T;
}

export const ROUTE_TIMEOUT_MS = 15_000;

/**
 * The Account state from the server route, or null when it is unavailable (error, bad answer or no
 * answer in time): the caller then reads the chain itself. `fresh` makes the server re-read its Holding
 * and Position lists first (after a transaction this app sent).
 */
export async function fetchRoutedState(authority: PublicKey, opts: { fresh?: boolean; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<AccountSnapshot | null> {
  try {
    const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const res = await doFetch(`/api/account/${authority.toBase58()}${opts.fresh ? "?fresh=1" : ""}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? ROUTE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const snap = decodeState<AccountSnapshot>(await res.json());
    return { ...snap, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}
