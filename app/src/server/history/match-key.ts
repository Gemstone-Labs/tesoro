/**
 * A Match id is the opener's Account plus the opener's counter value. In URLs and the history tables it
 * is `<opener>-<n>`: base58 never contains "-", so the split is unambiguous.
 */
export interface MatchKey {
  opener: string;
  n: bigint;
}

const MAX_U64 = (1n << 64n) - 1n;
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const matchKeyOf = (k: MatchKey): string => `${k.opener}-${k.n}`;

/** The Match id of a URL segment or table key, or null when it is not `<base58 key>-<u64>`. */
export function parseMatchKey(raw: string): MatchKey | null {
  const at = raw.lastIndexOf("-");
  if (at < 1) return null;
  const opener = raw.slice(0, at);
  const digits = raw.slice(at + 1);
  if (!BASE58_KEY.test(opener) || !/^\d{1,20}$/.test(digits) || (digits.length > 1 && digits.startsWith("0"))) return null;
  const n = BigInt(digits);
  return n <= MAX_U64 ? { opener, n } : null;
}
