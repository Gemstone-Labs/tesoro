"use client";

import { useSyncExternalStore } from "react";
import type { AccountInfo } from "@solana/web3.js";
import { getChain } from "./client";
import { basketPda, decodeStore, spillPda } from "./basket";
import { POOL_ACCOUNT } from "./leaderboard";

const POLL_MS = 60_000;

const BASKET = basketPda(POOL_ACCOUNT);
const SPILL = spillPda(POOL_ACCOUNT);

/** Playable Gemas of one store account (basket or spill header totals); 0 for a store that is not there, null for bytes that are not a store. */
const storeTotal = (info: AccountInfo<Buffer> | null): number | null => {
  if (!info) return 0;
  try {
    const { header } = decodeStore(info.data);
    return Number(header.ownTotal + header.wonTotal);
  } catch {
    return null;
  }
};

const parts: Record<"basket" | "spill", number | null> = { basket: null, spill: null };
const sum = (): number | null => (parts.basket === null || parts.spill === null ? null : parts.basket + parts.spill);

let total: number | null | undefined;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

const set = (next: number | null | undefined) => {
  if (next === total) return;
  total = next;
  for (const l of listeners) l();
};

/** One subscription per tab: the Pool's basket and spill over the RPC websocket, plus a slow re-read in case the socket drops. */
function start() {
  const base = getChain().base;
  const read = () =>
    base.getMultipleAccountsInfo([BASKET, SPILL], "confirmed").then(
      ([b, s]) => {
        parts.basket = storeTotal(b);
        parts.spill = storeTotal(s);
        set(sum());
      },
      () => set(total ?? null),
    );
  void read();
  const subs = [
    base.onAccountChange(BASKET, (info) => { parts.basket = storeTotal(info); set(sum()); }, { commitment: "confirmed" }),
    base.onAccountChange(SPILL, (info) => { parts.spill = storeTotal(info); set(sum()); }, { commitment: "confirmed" }),
  ];
  const poll = setInterval(read, POLL_MS);
  return () => {
    clearInterval(poll);
    for (const sub of subs) void base.removeAccountChangeListener(sub).catch(() => {});
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** Gemas in the Leaderboard Pool, live; undefined until the first read, null when it failed or the Leaderboard is off. */
export function usePool(): number | null | undefined {
  return useSyncExternalStore(subscribe, () => total, () => undefined);
}
