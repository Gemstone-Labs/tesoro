"use client";

import { useEffect, useState } from "react";
import { Connection, type PublicKey } from "@solana/web3.js";
import { ASSETS, ER_RPC, ER_WS, RULES, type Asset } from "./chain";

/** One oracle reading. `mid` is 1e-8 USD, exactly as the program reads it. */
export interface Tick {
  mid: bigint;
  /** Feed publish time, unix seconds. */
  publishedAt: number;
  /** When this client received it, ms. */
  receivedAt: number;
}

export interface Point {
  /** ms, the receive time (the feed's own clock has one-second resolution). */
  t: number;
  /** USD */
  p: number;
}

/** Feed account layout (Pyth PriceUpdateV2 image): price i64 at 73, exponent i32 at 89 (8 means 1e-8), publish time i64 at 93. */
export function decodeMid(data: Uint8Array): { mid: bigint; publishedAt: number } | null {
  if (data.length < 101) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const raw = dv.getBigInt64(73, true);
  if (raw <= 0n || Math.abs(dv.getInt32(89, true)) !== 8) return null;
  return { mid: raw, publishedAt: Number(dv.getBigInt64(93, true)) };
}

export const midToUsd = (mid: bigint): number => Number(mid) / 1e8;
export const usdToMid = (usd: number): bigint => BigInt(Math.round(usd * 1e8));

/** A series that is appended to in place: read `points` and compare `rev` to see whether it changed. */
export interface LiveSeries {
  points: Point[];
  /** Counts appends and trims. */
  rev: number;
}

/** The newest price is kept at this rate or better (ms): a quiet stretch still gets a point, so a flat price draws flat, not as a ramp to the next move. */
const HOLD_MS = 400;
/** Whole game at the feed's top rate (about 20 updates a second) fits twice over; older points are dropped in chunks. */
const KEEP_POINTS = 8000;
const KEEP_MS = 6 * 60_000;

/**
 * Every reading of one asset's feed, kept outside React: the feed pushes about 20 updates a second
 * and a screen that re-rendered for each would stutter. A point is kept for every price change (the
 * feed's own publish time has one-second resolution, so it says nothing about order), `tick` is the
 * newest reading, and `onUpdate` fires for every reading, changed or not.
 */
export class PriceStore implements LiveSeries {
  points: Point[] = [];
  rev = 0;
  tick: Tick | null = null;
  /** Readings seen, changed or not (for rate checks). */
  readings = 0;
  private listeners = new Set<(tick: Tick) => void>();

  /** Takes one reading at `now` (ms). Returns true when it made a new point. */
  ingest(mid: bigint, publishedAt: number, now: number): boolean {
    const tick: Tick = { mid, publishedAt, receivedAt: now };
    this.readings++;
    const last = this.points[this.points.length - 1];
    const p = midToUsd(mid);
    let added = false;
    if (!last || (now > last.t && p !== last.p)) {
      if (last && now - last.t > HOLD_MS) this.points.push({ t: now - 1, p: last.p });
      this.points.push({ t: now, p });
      added = true;
      this.trim(now);
      this.rev++;
    } else if (now > last.t && now - last.t >= HOLD_MS) {
      this.points.push({ t: now, p });
      this.rev++;
    }
    if (!this.tick || now >= this.tick.receivedAt) this.tick = tick;
    this.listeners.forEach((fn) => fn(tick));
    return added;
  }

  private trim(now: number) {
    const pts = this.points;
    if (pts.length < KEEP_POINTS + 500 && pts[0].t >= now - KEEP_MS - 5000) return;
    let from = 0;
    while (from < pts.length - 1 && pts[from].t < now - KEEP_MS) from++;
    from = Math.max(from, pts.length - KEEP_POINTS);
    if (from > 0) pts.splice(0, from);
  }

  onUpdate(fn: (tick: Tick) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  clear() {
    this.points = [];
    this.tick = null;
    this.readings = 0;
    this.rev++;
  }
}

/** One reading a second, newest last: the public history a bot may look at. */
export function perSecond(points: Point[], max = 60): number[] {
  const out: number[] = [];
  let at = Infinity;
  for (let i = points.length - 1; i >= 0 && out.length < max; i--) {
    if (points[i].t <= at - 1000) {
      out.push(points[i].p);
      at = points[i].t;
    } else if (!out.length) {
      out.push(points[i].p);
      at = points[i].t;
    }
  }
  return out.reverse();
}

/** A tick older than the program's staleness window would be refused on chain. */
export const isStale = (tick: Tick | null, now: number): boolean => !tick || now - tick.receivedAt > (RULES.maxStaleSecs + 1) * 1000;

export interface PriceFeed {
  /** The newest reading, refreshed once a second and on a change of status (read `store` for every one). */
  tick: Tick | null;
  /** Every reading, updated in place; hand it to the grid. */
  series: LiveSeries;
  store: PriceStore;
  /** "live" once readings arrive, "waiting" before the first one, "stale" when none for a while. */
  status: "waiting" | "live" | "stale";
}

const stores = new Map<string, { store: PriceStore; users: number; stop: (() => void) | null }>();
function entry(asset: Asset) {
  let e = stores.get(String(asset.id));
  if (!e) {
    e = { store: new PriceStore(), users: 0, stop: null };
    stores.set(String(asset.id), e);
  }
  return e;
}

const shared = new Map<string, Connection>();
function conn(): Connection {
  let c = shared.get("er");
  if (!c) {
    c = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
    shared.set("er", c);
  }
  return c;
}

/** Subscribes to the feed account and polls it once a second as the fallback (a missed socket or a quiet feed still reads). */
function connect(asset: Asset, store: PriceStore): () => void {
  let stop = false;
  const c = conn();
  const address: PublicKey = asset.feed;
  const apply = (data: Uint8Array) => {
    const d = decodeMid(data);
    if (d && !stop) store.ingest(d.mid, d.publishedAt, Date.now());
  };
  let subId: number | null = null;
  try {
    subId = c.onAccountChange(address, (info) => apply(info.data), "confirmed");
  } catch {
    subId = null;
  }
  const poll = async () => {
    try {
      const info = await c.getAccountInfo(address, "confirmed");
      if (info) apply(info.data);
    } catch {
      // the next poll retries
    }
  };
  void poll();
  const poller = setInterval(() => void poll(), 1000);
  return () => {
    stop = true;
    clearInterval(poller);
    if (subId !== null) void c.removeAccountChangeListener(subId).catch(() => undefined);
  };
}

/** The store of one asset's feed, connected while `enabled`. */
export function usePriceStore(asset: Asset | null, enabled = true): PriceStore {
  const store = asset ? entry(asset).store : EMPTY;
  useEffect(() => {
    if (!asset || !enabled) return;
    const e = entry(asset);
    if (e.users++ === 0) {
      e.store.clear();
      e.stop = connect(asset, e.store);
    }
    return () => {
      if (--e.users === 0) {
        e.stop?.();
        e.stop = null;
      }
    };
  }, [asset, enabled]);
  return store;
}
const EMPTY = new PriceStore();

/**
 * The live price of one asset from the rollup's pricing oracle. The line moves at the feed's own
 * rate (about 20 updates a second); React only hears about it once a second, for the text.
 * `showTick` false keeps `tick` as it was (the grid reads the store, so it does not need a render for each new number).
 * No wallet needed: the feed account is public.
 */
export function usePriceFeed(asset: Asset | null, enabled = true, showTick = true): PriceFeed {
  const store = usePriceStore(asset, enabled);
  const [snap, setSnap] = useState<{ tick: Tick | null; status: PriceFeed["status"] }>({ tick: null, status: "waiting" });
  useEffect(() => {
    if (!asset || !enabled) return;
    let shownAt = 0;
    const read = () => {
      const tick = store.tick;
      const now = Date.now();
      const status: PriceFeed["status"] = !tick ? "waiting" : isStale(tick, now) ? "stale" : "live";
      // The number shown beside the picker is refreshed once a second; a change of status at once.
      setSnap((s) => {
        if (s.status === status && (!showTick ? s.tick : now - shownAt < 1000 && s.tick)) return s;
        if (s.status === status && s.tick?.mid === tick?.mid) return s;
        shownAt = now;
        return { tick, status };
      });
    };
    const first = setTimeout(read, 0);
    const i = setInterval(read, 250);
    return () => {
      clearTimeout(first);
      clearInterval(i);
    };
  }, [asset, enabled, store, showTick]);
  return { ...snap, series: store, store };
}

export const assetBySymbol = (s: string | null | undefined): Asset => ASSETS.find((a) => a.symbol === s?.toUpperCase()) ?? ASSETS[0];
