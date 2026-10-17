"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { getChain } from "./client";
import { awayView, fetchAway, type AwayData, type AwayView } from "./protections";
import { useNowSecs } from "./useNowSecs";

const cache = new Map<string, { at: number; data: Promise<AwayData> }>();
const TTL_MS = 20_000;

function read(owner: Parameters<typeof fetchAway>[1]): Promise<AwayData> {
  const key = owner.toBase58();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = fetchAway(getChain().base, owner);
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  return data;
}

/** Forget what was read, so the next `useAway` read sees a Break that was just set. */
export const forgetAway = () => cache.clear();

/** The signed-in Player's Break or Self-Exclusion; null while it loads or when signed out. A read that fails counts as free (the program still refuses). */
export function useAway(): AwayView | null {
  const auth = useAuth();
  const owner = auth.signer?.publicKey;
  const key = owner?.toBase58();
  const now = useNowSecs(15_000);
  const [data, setData] = useState<AwayData | null>(null);
  useEffect(() => {
    if (!owner) return;
    let live = true;
    void read(owner)
      .catch(() => null)
      .then((d) => live && setData(d));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, now]);
  return owner ? awayView(data, now) : null;
}
