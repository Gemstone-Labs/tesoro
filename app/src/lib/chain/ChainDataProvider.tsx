"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/context";
import type { AccountSnapshot } from "./read";
import { plainError } from "@/lib/errors";

interface ChainData {
  snapshot: AccountSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY: ChainData = { snapshot: null, loading: false, error: null, refresh: async () => {} };
const Ctx = createContext<ChainData>(EMPTY);

const POLL_MS = 12_000;
/** A read that has not answered by then is dropped, so a hung request cannot freeze the Account. */
const READ_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Loading your Account took too long.")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

/** Reads the signed-in Account's on-chain state (tesoro_core) and keeps it fresh. */
export function ChainDataProvider({ children }: { children: ReactNode }) {
  const { addresses } = useAuth();
  const address = addresses.solana;
  const [state, setState] = useState<{ address: string | null; snapshot: AccountSnapshot | null; error: string | null }>({
    address: null,
    snapshot: null,
    error: null,
  });
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const readOnce = useCallback(async () => {
    if (!address) return;
    try {
      const { demoMode, demoSnapshot } = await import("./fixture");
      if (demoMode()) {
        setState({ address, snapshot: demoSnapshot(address), error: null });
        return;
      }
      const [{ PublicKey }, { fetchSnapshot }] = await Promise.all([import("@solana/web3.js"), import("./read")]);
      const snapshot = await withTimeout(fetchSnapshot(new PublicKey(address)), READ_TIMEOUT_MS);
      setState({ address, snapshot, error: null });
    } catch (e) {
      console.warn("[chain] Account read failed", e);
      setState((s) => ({ address, snapshot: s.address === address ? s.snapshot : null, error: plainError(e) }));
    }
  }, [address]);

  // One read at a time. A refresh during a read (after a transaction) waits for it and reads once more, so it sees the new state; a poll just skips.
  const load = useCallback((fresh: boolean): Promise<void> => {
    if (inflight.current) {
      if (fresh) again.current = true;
      return inflight.current;
    }
    const run = (async () => {
      do {
        again.current = false;
        await readOnce();
      } while (again.current);
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = run;
    return run;
  }, [readOnce]);

  useEffect(() => {
    if (!address) return;
    void load(false);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [address, load]);

  const refresh = useCallback(() => load(true), [load]);

  const value = useMemo<ChainData>(() => {
    const mine = state.address === address;
    return {
      snapshot: mine ? state.snapshot : null,
      loading: !!address && (!mine || (state.snapshot === null && state.error === null)),
      error: mine ? state.error : null,
      refresh,
    };
  }, [state, address, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useChainData = () => useContext(Ctx);
