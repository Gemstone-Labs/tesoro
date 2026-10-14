// Storybook: the signed-in Account's snapshot comes from the story (`parameters.data.snapshot`), never from chain.
import { useMemo, type ReactNode } from "react";
import { useAuth } from "../../../../../src/lib/auth/context";
import { demoSnapshot } from "../../../../../src/lib/chain/fixture";
import type { AccountSnapshot } from "../../../../../src/lib/chain/read";
import { storyData } from "../../../../../stories/support/data";

export function ChainDataProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useChainData() {
  const address = useAuth().addresses.solana;
  const { data } = storyData();
  return useMemo(() => {
    if (!address) return { snapshot: null, loading: false, error: null, refresh: async () => true };
    if (data.snapshotError) return { snapshot: null, loading: false, error: data.snapshotError, refresh: async () => true };
    const s = data.snapshot === undefined ? demoSnapshot(address) : typeof data.snapshot === "function" ? data.snapshot(address) : data.snapshot;
    return { snapshot: s as AccountSnapshot | null, loading: s === null, error: null, refresh: async () => true };
  }, [address, data]);
}
