"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackingBoard, PlayerRecord } from "./backing";
import { withTimeout } from "./timeout";
import { plainError } from "@/lib/errors";

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
      setBoard(await withTimeout(fetchBackingBoard(), 20_000));
      setError(null);
    } catch (e) {
      setError(plainError(e));
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

/**
 * The signed-in Player's own record, read from the same history Backers see on their Requests (finished Matches' accounts are
 * closed, so the chain no longer has them). Undefined while it loads, null when the history is unavailable.
 */
export function useOwnRecord(player: string | null, enabled: boolean): PlayerRecord | null | undefined {
  const [read, setRead] = useState<{ player: string; record: PlayerRecord | null } | null>(null);
  useEffect(() => {
    if (!player || !enabled) return;
    let live = true;
    void import("./backing").then(({ fetchPlayerRecord }) => fetchPlayerRecord(player)).then((record) => {
      if (live) setRead({ player, record });
    });
    return () => {
      live = false;
    };
  }, [player, enabled]);
  return read && read.player === player ? read.record : undefined;
}

/** "38 Matches · 61% won": the win rate always carries its sample size. */
export function recordShort(r: PlayerRecord): string {
  if (r.matches === 0) return "New Player · no settled Matches";
  return `${r.matches} ${r.matches === 1 ? "Match" : "Matches"} · ${Math.round((r.wins / r.matches) * 100)}% won`;
}

export { shortKey } from "./history";

/** The Request card's clock chip: "2d left" / "11h left" / "12m left" / "Closed". */
export function closesIn(unixSecs: number, nowMs = Date.now()): string {
  const s = Math.floor(unixSecs - nowMs / 1000);
  if (s <= 0) return "Closed";
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d left`;
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}h left` : `${Math.max(1, Math.floor(s / 60))}m left`;
}

/** "23h 41m left" / "12m left" / "Expired". */
export function timeLeft(unixSecs: number, nowMs = Date.now()): string {
  const s = Math.floor(unixSecs - nowMs / 1000);
  if (s <= 0) return "Expired";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : `${Math.max(1, m)}m left`;
}
