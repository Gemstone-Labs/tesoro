import { describe, expect, it } from "vitest";
import { PriceStore, decodeMid, isStale, midToUsd, perSecond, usdToMid } from "./feed";

function feedData(price: bigint, exp: number, published: bigint): Uint8Array {
  const b = new Uint8Array(134);
  const dv = new DataView(b.buffer);
  dv.setBigInt64(73, price, true);
  dv.setInt32(89, exp, true);
  dv.setBigInt64(93, published, true);
  return b;
}

describe("decodeMid", () => {
  it("reads price and publish time, for either exponent sign", () => {
    expect(decodeMid(feedData(11_933_940_047n, 8, 1790962895n))).toEqual({ mid: 11_933_940_047n, publishedAt: 1790962895 });
    expect(decodeMid(feedData(5n, -8, 7n))?.mid).toBe(5n);
  });
  it("refuses short data, zero prices and other exponents", () => {
    expect(decodeMid(new Uint8Array(50))).toBeNull();
    expect(decodeMid(feedData(0n, 8, 1n))).toBeNull();
    expect(decodeMid(feedData(5n, 6, 1n))).toBeNull();
  });
  it("converts to and from USD", () => {
    expect(midToUsd(11_933_940_047n)).toBeCloseTo(119.33940047, 8);
    expect(usdToMid(100)).toBe(10_000_000_000n);
  });
});

describe("PriceStore", () => {
  const mid = (usd: number) => usdToMid(usd);
  it("keeps a point for every price change, even inside one feed second", () => {
    const st = new PriceStore();
    for (let i = 0; i < 20; i++) st.ingest(mid(100 + (i % 3) * 0.01), 1000, 10_000 + i * 50);
    expect(st.points.length).toBeGreaterThanOrEqual(20);
    expect(st.readings).toBe(20);
    expect(st.tick?.receivedAt).toBe(10_000 + 19 * 50);
  });
  it("refreshes the head on a reading that changed nothing, without a new point", () => {
    const st = new PriceStore();
    st.ingest(mid(100), 1, 1000);
    const rev = st.rev;
    st.ingest(mid(100), 1, 1100);
    expect(st.points).toHaveLength(1);
    expect(st.rev).toBe(rev);
    expect(st.tick?.receivedAt).toBe(1100);
  });
  it("holds a quiet price flat instead of leaving a ramp to the next move", () => {
    const st = new PriceStore();
    st.ingest(mid(100), 1, 1000);
    st.ingest(mid(101), 5, 5000);
    expect(st.points.map((x) => [x.t, x.p])).toEqual([
      [1000, 100],
      [4999, 100],
      [5000, 101],
    ]);
  });
  it("keeps a whole game at the feed's top rate and drops the oldest in chunks", () => {
    const st = new PriceStore();
    for (let i = 0; i < 3600; i++) st.ingest(mid(100 + (i % 2) * 0.01), 0, i * 50);
    expect(st.points.length).toBe(3600);
    for (let i = 3600; i < 12_000; i++) st.ingest(mid(100 + (i % 2) * 0.01), 0, i * 50);
    expect(st.points.length).toBeLessThanOrEqual(8500);
    expect(st.points[st.points.length - 1].t).toBe(11_999 * 50);
  });
  it("calls listeners for every reading and ignores a reading older than the head", () => {
    const st = new PriceStore();
    const seen: number[] = [];
    const off = st.onUpdate((t) => seen.push(t.receivedAt));
    st.ingest(mid(100), 1, 1000);
    st.ingest(mid(100), 1, 1050);
    off();
    st.ingest(mid(100), 1, 1100);
    st.ingest(mid(101), 1, 1000);
    expect(seen).toEqual([1000, 1050]);
    expect(st.points.every((x, i, a) => !i || x.t > a[i - 1].t)).toBe(true);
    expect(st.tick?.receivedAt).toBe(1100);
  });
});

describe("perSecond", () => {
  it("thins a dense series to one reading a second, newest last", () => {
    const pts = Array.from({ length: 101 }, (_, i) => ({ t: i * 100, p: i }));
    const out = perSecond(pts);
    expect(out[out.length - 1]).toBe(100);
    expect(out).toHaveLength(11);
    expect(out[0]).toBe(0);
  });
});

describe("isStale", () => {
  it("is stale a second past the program window (2 s plus one for the client clock)", () => {
    const tick = { mid: 1n, publishedAt: 1, receivedAt: 1000 };
    expect(isStale(tick, 4000)).toBe(false);
    expect(isStale(tick, 4001)).toBe(true);
    expect(isStale(null, 0)).toBe(true);
  });
});
