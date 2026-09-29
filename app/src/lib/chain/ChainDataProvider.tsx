"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/context";
import type { AccountSnapshot } from "./read";

interface ChainData {
  snapshot: AccountSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY: ChainData = { snapshot: null, loading: false, error: null, refresh: async () => {} };
const Ctx = createContext<ChainData>(EMPTY);

const POLL_MS = 12_000;

/** Reads the signed-in Account's on-chain state (tesoro_core) and keeps it fresh. */
export function ChainDataProvider({ children }: { children: ReactNode }) {
  const { addresses } = useAuth();
  const address = addresses.solana;
  const [state, setState] = useState<{ address: string | null; snapshot: AccountSnapshot | null; error: string | null }>({
    address: null,
    snapshot: null,
    error: null,
  });
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (!address || inflight.current) return;
    inflight.current = true;
    try {
      const [{ PublicKey }, { fetchSnapshot }] = await Promise.all([import("@solana/web3.js"), import("./read")]);
      const snapshot = await fetchSnapshot(new PublicKey(address));
      setState({ address, snapshot, error: null });
    } catch (e) {
      setState((s) => ({ address, snapshot: s.address === address ? s.snapshot : null, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      inflight.current = false;
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [address, load]);

  const value = useMemo<ChainData>(() => {
    const mine = state.address === address;
    return {
      snapshot: mine ? state.snapshot : null,
      loading: !!address && (!mine || (state.snapshot === null && state.error === null)),
      error: mine ? state.error : null,
      refresh: load,
    };
  }, [state, address, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useChainData = () => useContext(Ctx);
