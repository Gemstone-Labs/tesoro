"use client";

import { useEffect, useRef, useState } from "react";
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

/** Appends a point (one per feed update), keeping at most `max` and dropping anything older than `maxAgeMs`. */
export function pushPoint(series: Point[], pt: Point, max = 1200, maxAgeMs = 12 * 60_000): Point[] {
  const last = series[series.length - 1];
  if (last && pt.t <= last.t) return series;
  const next = [...series, pt];
  const cutoff = pt.t - maxAgeMs;
  let from = 0;
  while (from < next.length - 1 && next[from].t < cutoff) from++;
  return next.slice(Math.max(from, next.length - max));
}

/** A tick older than the program's staleness window would be refused on chain. */
export const isStale = (tick: Tick | null, now: number): boolean => !tick || now - tick.receivedAt > (RULES.maxStaleSecs + 1) * 1000;

export interface PriceFeed {
  tick: Tick | null;
  series: Point[];
  /** "live" once readings arrive, "waiting" before the first one, "stale" when none for a while. */
  status: "waiting" | "live" | "stale";
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

/**
 * The live price of one asset from the rollup's pricing oracle: an account subscription over
 * WebSocket with a one-second poll as the fallback (a missed socket or a quiet feed still ticks).
 * No wallet needed: the feed account is public.
 */
export function usePriceFeed(asset: Asset | null, enabled = true): PriceFeed {
  const [feed, setFeed] = useState<PriceFeed>({ tick: null, series: [], status: "waiting" });
  const lastPublished = useRef(0);

  useEffect(() => {
    if (!asset || !enabled) return;
    let stop = false;
    const c = conn();
    const address: PublicKey = asset.feed;
    lastPublished.current = 0;
    const timer = setTimeout(() => setFeed({ tick: null, series: [], status: "waiting" }), 0);

    const apply = (data: Uint8Array) => {
      const d = decodeMid(data);
      if (!d || stop) return;
      const now = Date.now();
      setFeed((f) => {
        const tick: Tick = { mid: d.mid, publishedAt: d.publishedAt, receivedAt: now };
        // One chart point per new publish; later reads of the same publish only refresh `receivedAt`.
        if (d.publishedAt === lastPublished.current && f.tick) return { ...f, tick: { ...f.tick, receivedAt: now }, status: "live" };
        lastPublished.current = d.publishedAt;
        return { tick, series: pushPoint(f.series, { t: now, p: midToUsd(d.mid) }), status: "live" };
      });
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
    const staleCheck = setInterval(() => {
      setFeed((f) => (f.status === "live" && isStale(f.tick, Date.now()) ? { ...f, status: "stale" } : f));
    }, 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(poller);
      clearInterval(staleCheck);
      if (subId !== null) void c.removeAccountChangeListener(subId).catch(() => undefined);
    };
  }, [asset, enabled]);

  return feed;
}

export const assetBySymbol = (s: string | null | undefined): Asset => ASSETS.find((a) => a.symbol === s?.toUpperCase()) ?? ASSETS[0];
