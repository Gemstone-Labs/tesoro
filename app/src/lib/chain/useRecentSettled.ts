"use client";

import { useCallback, useSyncExternalStore } from "react";
import { topScores, type SettledMatch } from "./settled";

const POLL_MS = 30_000;

interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface Entry<T> {
  state: QueryState<T>;
  fetch: () => Promise<T>;
  at: number;
  inflight: boolean;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const IDLE: QueryState<never> = { data: null, error: null, loading: false };
const entries = new Map<string, Entry<unknown>>();

function load<T>(e: Entry<T>) {
  if (e.inflight) return;
  e.inflight = true;
  e.fetch().then(
    (data) => {
      e.at = Date.now();
      e.state = { data, error: null, loading: false };
    },
    (err: unknown) => {
      // Keep the last good data; say that the refresh failed.
      e.state = { data: e.state.data, error: err instanceof Error ? err.message : String(err), loading: false };
    },
  ).finally(() => {
    e.inflight = false;
    e.subs.forEach((f) => f());
  });
}

function entryFor<T>(key: string, fetch: () => Promise<T>): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { state: { data: null, error: null, loading: true }, fetch, at: 0, inflight: false, subs: new Set(), timer: null };
    entries.set(key, e as Entry<unknown>);
  }
  return e;
}

/**
 * One shared, cached, polled read per `key`: every component asking for the same key shares one
 * request and one 30 s poll (only while the tab is visible). Data stays cached across remounts and
 * a failed refresh keeps the last good data alongside the error. A null key reads nothing.
 */
export function useSharedQuery<T>(key: string | null, fetch: () => Promise<T>): QueryState<T> {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!key) return () => {};
      const e = entryFor(key, fetch);
      e.subs.add(notify);
      if (e.subs.size === 1) {
        if (Date.now() - e.at > POLL_MS) load(e);
        e.timer = setInterval(() => {
          if (document.visibilityState === "visible") load(e);
        }, POLL_MS);
      }
      return () => {
        e.subs.delete(notify);
        if (e.subs.size === 0 && e.timer) {
          clearInterval(e.timer);
          e.timer = null;
        }
      };
    },
    [key, fetch],
  );
  return useSyncExternalStore(
    subscribe,
    () => (key ? entryFor(key, fetch).state : IDLE),
    () => IDLE,
  );
}

/** Re-reads a shared query now (a "Try again" after a failed read). */
export function refreshShared(key: string) {
  const e = entries.get(key);
  if (e) load(e);
}

async function settled<T>(read: (r: typeof import("./recent")) => Promise<T>, demo: (f: typeof import("./fixture")) => T): Promise<T> {
  const fixture = await import("./fixture");
  if (fixture.demoMode()) return demo(fixture);
  return read(await import("./recent"));
}

/** Recent settled Matches from Solana devnet (public read, works signed out). */
export function useRecentSettled(limit = 8): { matches: SettledMatch[]; loading: boolean; error: string | null } {
  const fetch = useCallback(() => settled((r) => r.fetchRecentSettled(limit), (f) => f.demoSettled()), [limit]);
  const q = useSharedQuery(`recent:${limit}`, fetch);
  return { matches: q.data ?? [], loading: q.loading || (q.data === null && q.error === null), error: q.error };
}

const fetchTopToday = () =>
  settled(
    (r) => r.fetchTopScoresToday(),
    (f) => topScores(f.demoSettled().filter((m) => m.game === "block-puzzle")),
  );

/** The best winning Block Burst scores of the last 24 hours (other games have none). */
export function useTopScoresToday(enabled: boolean): QueryState<[string, number][]> {
  return useSharedQuery(enabled ? "top-scores-today" : null, fetchTopToday);
}

