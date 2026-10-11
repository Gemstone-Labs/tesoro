"use client";

import { useCallback, useEffect, useState } from "react";
import type { LeaderboardView } from "./leaderboard-view";

const POLL_MS = 30_000;

/** The leaderboard from `/api/leaderboard`, re-read every 30 s while the page is open. Keeps the last good data on an error. `me` adds that Account's row (`data.me`). */
export function useLeaderboard(me?: string | null) {
  const [data, setData] = useState<LeaderboardView | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(me ? `/api/leaderboard?me=${me}` : "/api/leaderboard", { signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]) });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as LeaderboardView);
      setError(false);
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, [me]);

  useEffect(() => {
    const ctl = new AbortController();
    const first = setTimeout(() => void load(ctl.signal), 0);
    const t = setInterval(() => void load(ctl.signal), POLL_MS);
    return () => {
      ctl.abort();
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  return { data, error, retry: () => void load() };
}
