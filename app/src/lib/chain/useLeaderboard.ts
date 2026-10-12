"use client";

import { useCallback, useEffect, useState } from "react";
import type { LeaderboardView } from "./leaderboard-view";

const POLL_MS = 30_000;

/** The leaderboard from `/api/leaderboard`, re-read every 30 s while the page is open. Keeps the last good data on an error. `me` adds that Account's row (`data.me`). */
export function useLeaderboard(me?: string | null) {
  const [read, setRead] = useState<{ me: string | null; view: LeaderboardView } | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(me ? `/api/leaderboard?me=${me}` : "/api/leaderboard", { signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]) });
      if (!res.ok) throw new Error(String(res.status));
      const view = (await res.json()) as LeaderboardView;
      setRead({ me: me ?? null, view });
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

  // `forMe`: the data was read for this `me`, so `data.me` is this Account's row (not an earlier Account's, or none).
  return { data: read?.view ?? null, forMe: !!read && read.me === (me ?? null), error, retry: () => void load() };
}
