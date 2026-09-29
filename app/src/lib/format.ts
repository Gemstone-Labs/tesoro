import type { Asset } from "./mock/types";

export const GEMA_USD_AT_ISSUANCE = 0.01;

export function fmtGemas(n: number): string {
  return Math.round(n).toLocaleString("en-US");
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

const ASSET_DECIMALS: Record<Asset, number> = { SOL: 3, ETH: 4, HYPE: 3 };

export function fmtAsset(amount: number, asset: Asset): string {
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: ASSET_DECIMALS[asset],
    maximumFractionDigits: ASSET_DECIMALS[asset],
  })} ${asset}`;
}

/** Fixed-zone formatting so server and client render the same string. */
export function fmtWhen(iso: string): string {
  const s = new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${s} UTC`;
}
