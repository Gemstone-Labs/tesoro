"use client";

import { useSyncExternalStore } from "react";
import type { AccountInfo } from "@solana/web3.js";
import { getChain } from "./client";
import { POOL_ACCOUNT } from "./leaderboard";

const POLL_MS = 60_000;

// TesoroAccount: disc 8, bump 1, authority 32, evm 20, then own_total and won_total (see leaderboard.ts).
const TOTALS_AT = 8 + 1 + 32 + 20;
const totalOf = (info: AccountInfo<Buffer> | null): number | null => {
  if (!info || info.data.length < TOTALS_AT + 16) return null;
  // DataView, not Buffer: the browser's Buffer polyfill has no readBigUInt64LE.
  const d = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  return Number(d.getBigUint64(TOTALS_AT, true) + d.getBigUint64(TOTALS_AT + 8, true));
};

let total: number | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

const set = (next: number | null) => {
  if (next === total) return;
  total = next;
  for (const l of listeners) l();
};

/** One subscription per tab: the pool Account over the RPC websocket, plus a slow re-read in case the socket drops. */
function start() {
  const base = getChain().base;
  const read = () => base.getAccountInfo(POOL_ACCOUNT, "confirmed").then(totalOf, () => total).then(set);
  void read();
  const sub = base.onAccountChange(POOL_ACCOUNT, (info) => set(totalOf(info)), { commitment: "confirmed" });
  const poll = setInterval(read, POLL_MS);
  return () => {
    clearInterval(poll);
    void base.removeAccountChangeListener(sub).catch(() => {});
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

/** Gemas in the Leaderboard Pool, live; null until the first read (or while the Leaderboard is off). */
export function usePool(): number | null {
  return useSyncExternalStore(subscribe, () => total, () => null);
}
