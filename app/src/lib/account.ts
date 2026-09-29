import { account, holdings, matches, offers, positions, requests } from "./mock";
import type { Account, GemaHolding, Match, Offer, Position, Request } from "./mock";

export interface AccountView {
  account: Account;
  positions: Position[];
  holdings: GemaHolding[];
  matches: Match[];
  /** Totals derived from holdings; never stored separately. */
  gemas: { total: number; redeemable: number; pending: number };
}

export function redeemableOf(h: GemaHolding): number {
  return Math.round(h.gemas * h.accruedShare);
}

/**
 * The single seam for Account data. Today it returns mock data; the Privy +
 * chain clients replace this body later without touching any screen.
 */
export function useAccount(): AccountView {
  const total = holdings.reduce((s, h) => s + h.gemas, 0);
  const redeemable = holdings.reduce((s, h) => s + redeemableOf(h), 0);
  return {
    account,
    positions,
    holdings,
    matches,
    gemas: { total, redeemable, pending: total - redeemable },
  };
}

export interface BackingView {
  requests: Request[];
  offers: Offer[];
}

/** Seam for Backing data (Requests and Offers). */
export function useBacking(): BackingView {
  return { requests, offers };
}
