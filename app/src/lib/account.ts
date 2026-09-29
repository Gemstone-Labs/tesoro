import { holdings, matches, offers, positions, requests } from "./mock";
import { useAuth } from "./auth/context";
import type { AuthState } from "./auth/types";
import type { Account, GemaHolding, Match, Offer, Position, Request } from "./mock";

export interface AccountView {
  account: Account;
  /** Real session: sign-in state, embedded/linked wallets, sign-in gate. */
  auth: AuthState;
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
 * The single seam for Account data. Identity (addresses, sign-in state) comes from the
 * Privy session; Positions, Gemas and Matches are still mock until they are on-chain.
 */
export function useAccount(): AccountView {
  const auth = useAuth();
  const total = holdings.reduce((s, h) => s + h.gemas, 0);
  const redeemable = holdings.reduce((s, h) => s + redeemableOf(h), 0);
  const account: Account = {
    id: auth.email ?? "guest",
    displayName: auth.email?.split("@")[0] ?? "Guest",
    addresses: auth.addresses,
  };
  return {
    account,
    auth,
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
