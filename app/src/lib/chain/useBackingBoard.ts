"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackingBoard, PlayerRecord } from "./backing";
import type { ChainMatch } from "./read";

const POLL_MS = 12_000;

export interface BackingData {
  board: BackingBoard | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Requests and Offers on Solana devnet. Public reads: works signed out. Refreshes while the tab is visible. */
export function useBackingBoard(): BackingData {
  const [board, setBoard] = useState<BackingBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const { demoMode, demoBoard } = await import("./fixture");
      if (demoMode()) {
        setBoard(demoBoard());
        setError(null);
        return;
      }
      const { fetchBackingBoard } = await import("./backing");
      setBoard(await fetchBackingBoard());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  return { board, loading, error, refresh };
}

/** "5 of 8 won · 8 settled Matches": the win rate always carries its sample size. */
export function recordText(r: PlayerRecord): string {
  if (r.matches === 0) return "No settled Matches yet";
  return `${r.wins} of ${r.matches} won (${Math.round((r.wins / r.matches) * 100)}%) · ${r.matches} settled ${r.matches === 1 ? "Match" : "Matches"}`;
}

/** The signed-in Player's own record from their settled Matches (same rule the Request shows to Backers). */
export function recordFromMatches(matches: ChainMatch[]): PlayerRecord {
  let n = 0;
  let wins = 0;
  for (const m of matches) {
    if (m.status !== "settled" || m.seat === null) continue;
    const result = m.session ? m.session.result : m.winner;
    if (!result || result === "draw") continue;
    n += 1;
    if ((result === "opener") === (m.seat === 0)) wins += 1;
  }
  return { matches: n, wins };
}

export const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/** "23h 41m left" / "12m left" / "Expired". */
export function timeLeft(unixSecs: number, nowMs = Date.now()): string {
  const s = Math.floor(unixSecs - nowMs / 1000);
  if (s <= 0) return "Expired";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : `${Math.max(1, m)}m left`;
}
