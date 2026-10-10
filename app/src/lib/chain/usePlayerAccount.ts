"use client";

import { useCallback } from "react";
import type { PlayerAccount } from "./player-account";
import { orFallback, withTimeout } from "./timeout";
import { refreshShared, useSharedQuery } from "./useRecentSettled";

const READ_MS = 25_000;
const ASKS_MS = 8_000;

async function read(key: string): Promise<PlayerAccount> {
  const fixture = await import("./fixture");
  if (fixture.demoMode()) return fixture.demoPlayerAccount(key);
  const [{ PublicKey }, { accountExists, fetchAccountMatches }, { fetchLiveRequests }, { playerSummary }] = await Promise.all([
    import("@solana/web3.js"),
    import("./read"),
    import("./backing"),
    import("./player-account"),
  ]);
  const address = new PublicKey(key);
  // The Matches are the page; the asks beside them are not: a slow read of those must not hold the page back.
  const { played } = await withTimeout(fetchAccountMatches(address), READ_MS);
  const requests = await orFallback(fetchLiveRequests(key, playerSummary(played).record), ASKS_MS, []);
  // An Account that played or asked to be backed exists; only an address with neither needs the extra read.
  const exists = played.length > 0 || requests.length > 0 || (await withTimeout(accountExists(address), ASKS_MS));
  return { exists, played, requests };
}

/** Any Player's Account by its key, from Solana devnet (public read, works signed out). Shared and polled like the Lobby feeds. */
export function usePlayerAccount(key: string | null) {
  const fetch = useCallback(() => read(key as string), [key]);
  const id = key ? `account:${key}` : null;
  const q = useSharedQuery(id, fetch);
  const refresh = useCallback(() => {
    if (id) refreshShared(id);
  }, [id]);
  return { ...q, refresh };
}
