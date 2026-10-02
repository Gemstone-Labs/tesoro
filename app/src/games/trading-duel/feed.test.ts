import { describe, expect, it } from "vitest";
import { decodeMid, isStale, pushPoint, usdToMid, midToUsd } from "./feed";

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

describe("pushPoint", () => {
  it("ignores out-of-order points and caps the length", () => {
    let s = pushPoint([], { t: 10, p: 1 });
    s = pushPoint(s, { t: 5, p: 2 });
    expect(s).toHaveLength(1);
    for (let i = 0; i < 50; i++) s = pushPoint(s, { t: 20 + i, p: i }, 10);
    expect(s).toHaveLength(10);
    expect(s[9].p).toBe(49);
  });
  it("drops points past the age window", () => {
    let s = pushPoint([], { t: 0, p: 1 }, 100, 1000);
    s = pushPoint(s, { t: 500, p: 2 }, 100, 1000);
    s = pushPoint(s, { t: 2000, p: 3 }, 100, 1000);
    expect(s.map((p) => p.p)).toEqual([3]);
  });
});

describe("isStale", () => {
  it("is stale past the program's window", () => {
    const tick = { mid: 1n, publishedAt: 1, receivedAt: 1000 };
    expect(isStale(tick, 5000)).toBe(false);
    expect(isStale(tick, 6001)).toBe(true);
    expect(isStale(null, 0)).toBe(true);
  });
});
