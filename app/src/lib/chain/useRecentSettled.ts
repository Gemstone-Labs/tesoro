"use client";

import { useEffect, useState } from "react";
import type { SettledMatch } from "./recent";

const POLL_MS = 30_000;

/** Recent settled Matches from Solana devnet (public read, works signed out). */
export function useRecentSettled(limit = 8): { matches: SettledMatch[]; loading: boolean } {
  const [matches, setMatches] = useState<SettledMatch[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    let inflight = false;
    const load = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const { demoMode, demoSettled } = await import("./fixture");
        const { fetchRecentSettled } = await import("./recent");
        const rows = demoMode() ? demoSettled() : await fetchRecentSettled(limit);
        if (live) setMatches(rows);
      } catch {
        // the ticker is decoration: keep the last good list
      } finally {
        inflight = false;
        if (live) setLoading(false);
      }
    };
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [limit]);
  return { matches, loading };
}
