import { describe, expect, it } from "vitest";
import { DELIVERY_CEILING_BPS, deliveryQuote, parseDeliveryTerms, type DeliveryTerms } from "./delivery-fee";

const ETH = 10n ** 18n;
/** 0.00001 ETH flat, absolute cap 0.001 ETH, 2% on Unlock/Instant, 10% on yield, minimum Redeem 0.0005 ETH. */
const terms: DeliveryTerms = {
  eid: 40449,
  deliveryFee: 10_000_000_000_000n,
  maxAbs: 10n ** 15n,
  minRedeem: 500_000_000_000_000n,
  maxBpsUnlock: 200,
  maxBpsYield: 1000,
  minPrizeGemas: 1n,
};

describe("deliveryQuote", () => {
  it("Ana redeeming 0.01 ETH of yield pays the flat fee and gets the rest", () => {
    const q = deliveryQuote({ terms, payoutUnits: ETH / 100n, kind: "yield" });
    expect(q).toEqual({ fee: 10_000_000_000_000n, youGet: 9_990_000_000_000_000n, belowMinimum: false });
  });

  it("Ben unlocking 0.0003 ETH sees the fee shrink to 2% of his principal", () => {
    const q = deliveryQuote({ terms, payoutUnits: 300_000_000_000_000n, kind: "unlock" });
    expect(q.fee).toBe(6_000_000_000_000n);
    expect(q.youGet).toBe(294_000_000_000_000n);
  });

  it("an Unlock is never blocked by the minimum Redeem", () => {
    expect(deliveryQuote({ terms, payoutUnits: 1n, kind: "unlock" }).belowMinimum).toBe(false);
  });

  it("a Redeem under the minimum is flagged so the sheet can say so before signing", () => {
    expect(deliveryQuote({ terms, payoutUnits: 499_999_999_999_999n, kind: "yield" }).belowMinimum).toBe(true);
    expect(deliveryQuote({ terms, payoutUnits: 500_000_000_000_000n, kind: "instant" }).belowMinimum).toBe(false);
  });

  it("no setting takes more than the 10% ceiling", () => {
    const wild = { ...terms, deliveryFee: 10n ** 30n, maxAbs: 10n ** 30n, maxBpsYield: 10_000 };
    expect(deliveryQuote({ terms: wild, payoutUnits: 1_000_000n, kind: "yield" }).fee).toBe(100_000n);
    expect(DELIVERY_CEILING_BPS).toBe(1000);
  });

  it("a free delivery leaves the Player everything", () => {
    const q = deliveryQuote({ terms: { ...terms, deliveryFee: 0n }, payoutUnits: ETH, kind: "yield" });
    expect(q).toMatchObject({ fee: 0n, youGet: ETH });
  });
});

describe("parseDeliveryTerms", () => {
  it("reads the account the bridge writes", () => {
    const d = Buffer.alloc(8 + 4 + 32 + 1 + 16 * 3 + 2 + 2 + 8);
    d.writeUInt32LE(40449, 8);
    d.writeBigUInt64LE(10_000_000_000_000n, 45);
    d.writeBigUInt64LE(10n ** 15n, 61);
    d.writeBigUInt64LE(500_000_000_000_000n, 77);
    d.writeUInt16LE(200, 93);
    d.writeUInt16LE(1000, 95);
    d.writeBigUInt64LE(5n, 97);
    expect(parseDeliveryTerms(d)).toEqual({ ...terms, minPrizeGemas: 5n });
  });

  it("returns null for a missing or short account", () => {
    expect(parseDeliveryTerms(Buffer.alloc(10))).toBeNull();
  });
});
