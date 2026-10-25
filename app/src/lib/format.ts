import type { Asset } from "./mock/types";

export const GEMA_USD_AT_ISSUANCE = 0.01;

export function fmtGemas(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "100, 500 or 1,000": entry sizes as prose. */
export function fmtEntryList(sizes: readonly number[]): string {
  return orList(sizes.map((n) => fmtGemas(n)));
}

/** "a, b or c". */
export function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

export function fmtUsd(n: number): string {
  const small = n < 100;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: small ? 2 : 0,
    maximumFractionDigits: small ? 2 : 0,
  });
}

export function gemasToUsd(gemas: number): number {
  return gemas * GEMA_USD_AT_ISSUANCE;
}

/** Approximate issuance value of a Gema amount: "≈ $19", "≈ $4.50". */
export function fmtGemasUsd(gemas: number): string {
  const usd = gemasToUsd(gemas);
  const whole = Math.abs(usd - Math.round(usd)) < 1e-9 || usd >= 100;
  return `≈ ${usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

const ASSET_DECIMALS: Record<Asset, number> = { SOL: 3, ETH: 4, HYPE: 3 };

export function fmtAsset(amount: number, asset: Asset): string {
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: ASSET_DECIMALS[asset],
    maximumFractionDigits: ASSET_DECIMALS[asset],
  })} ${asset}`;
}

/** Time left until an Unlock Estimate: "in ~8 min", or "any moment now" under 45 s. */
export function fmtInMinutes(targetMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  return s < 45 ? "any moment now" : `in ~${Math.round(s / 60)} min`;
}

/** The viewer's local time, e.g. "Oct 3, 17:05". Only for values read in the browser (Unlock Estimates). */
export function fmtWhen(at: string | number): string {
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
