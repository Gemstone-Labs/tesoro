"use client";

import { useEffect, useSyncExternalStore } from "react";
import { PublicKey } from "@solana/web3.js";
import { EMPTY_IDENTITY, type Identity, type NameRecord, type ProfileData } from "./display";

/**
 * Every Player on screen, by Account key: Profile and .sol / .eth / .hl names. Requests made in the same
 * moment are read together (two lookups for a whole page); nothing here ever blocks rendering, and a
 * Player whose lookups fail keeps showing as a short key.
 */
const identities = new Map<string, Identity>();
const asked = new Set<string>();
const queue = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const BATCH = 50;
const FLUSH_MS = 40;
const NAMES_TIMEOUT_MS = 12_000;

function emit() {
  listeners.forEach((l) => l());
}

function put(key: string, patch: Partial<Identity>) {
  const prev = identities.get(key) ?? EMPTY_IDENTITY;
  identities.set(key, { ...prev, ...patch });
}

function settle(keys: string[]) {
  keys.forEach((k) => put(k, { settled: true }));
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Starts reading a Player once per tab. */
export function requestIdentity(key: string) {
  if (asked.has(key) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) return;
  asked.add(key);
  queue.add(key);
  timer ??= setTimeout(flush, FLUSH_MS);
}

/** Re-reads one Player (after saving a Profile). */
export function refreshIdentity(key: string) {
  asked.delete(key);
  requestIdentity(key);
}

/** Shows a Profile right away, before the next read confirms it. */
export function setProfileLocal(key: string, profile: ProfileData) {
  put(key, { profile });
  emit();
}

export async function fetchNames(wallets: string[], evm: string[]): Promise<{ solana: Record<string, NameRecord | null>; evm: Record<string, NameRecord | null>; hl: Record<string, NameRecord | null> }> {
  const res = await fetch("/api/names", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ solana: wallets, evm }),
    signal: AbortSignal.timeout(NAMES_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`names ${res.status}`);
  return res.json();
}

async function flush() {
  timer = null;
  const keys = [...queue];
  queue.clear();
  for (let i = 0; i < keys.length; i += BATCH) void readBatch(keys.slice(i, i + BATCH));
}

async function readBatch(keys: string[]) {
  const { demoMode } = await import("@/lib/chain/fixture");
  if (demoMode()) return settle(keys);
  let chain: Awaited<ReturnType<typeof import("./chain").fetchPlayerChainData>>;
  try {
    const { fetchPlayerChainData } = await import("./chain");
    chain = await fetchPlayerChainData(keys.map((k) => new PublicKey(k)));
  } catch (e) {
    console.warn("[identity] profile read failed", e);
    keys.forEach((k) => asked.delete(k));
    return settle(keys);
  }
  // A Profile with its own picture decides everything; otherwise the names below may still change the label or picture.
  keys.forEach((k, i) => {
    const p = chain[i].profile;
    put(k, { profile: p, attached: chain[i].attached, ...(p && p.avatar.kind !== "name-service" ? { settled: true } : {}) });
  });
  emit();

  const wallets = [...new Set(chain.flatMap((c) => c.wallets))];
  const evm = [...new Set(chain.flatMap((c) => c.evms))];
  if (wallets.length === 0 && evm.length === 0) return settle(keys);
  try {
    const names = await fetchNames(wallets, evm);
    // The server answers with checksummed addresses; the chain data is lowercase.
    const ethByLower = new Map(Object.entries(names.evm).map(([addr, n]) => [addr.toLowerCase(), n]));
    const hlByLower = new Map(Object.entries(names.hl ?? {}).map(([addr, n]) => [addr.toLowerCase(), n]));
    keys.forEach((k, i) => {
      const sol = chain[i].wallets.map((w) => names.solana[w]).find((n) => n) ?? null;
      const eth = chain[i].evms.map((e) => ethByLower.get(e)).find((n) => n) ?? null;
      const hl = chain[i].evms.map((e) => hlByLower.get(e)).find((n) => n) ?? null;
      put(k, { sol, eth, hl, settled: true });
    });
    emit();
  } catch (e) {
    // The Profile is already shown; names simply do not appear this time.
    console.warn("[identity] name lookup failed", e);
    settle(keys);
  }
}

/** How one Player is known right now; empty until the first read lands. */
export function useIdentity(key: string | null | undefined): Identity {
  useEffect(() => {
    if (key) requestIdentity(key);
  }, [key]);
  return useSyncExternalStore(
    subscribe,
    () => (key ? (identities.get(key) ?? EMPTY_IDENTITY) : EMPTY_IDENTITY),
    () => EMPTY_IDENTITY,
  );
}
