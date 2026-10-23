import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES,
  NATIVE_CUSTODY_LEN,
  TREASURY_LEN,
  parseNativeRoute,
  VAULT_TREASURY_LEN,
  instantPayoutFor,
  maxInstantGemas,
  parseTreasury,
  parseVaultShares,
  parseVaultTreasury,
  vaultTreasuryAvailable,
  instantTryCap,
  instantUnavailable,
  INSTANT_NOT_OPEN,
  INSTANT_UNAVAILABLE_BODY,
  planInstant,
  type InstantLine,
  replanInstant,
  ratesOf,
  solPayoutCapacity,
} from "./fees";

/** 1 Gema = $0.01; SOL at $150: 1 Gema = 10^13 / 150,000,000 lamports. */
const sol = { unitNum: 10n ** 13n, unitDen: 150_000_000n };
/** ETH at $3,180 (18 decimals): 1 Gema = 10^22 / 3,180,000,000 wei. */
const eth = { unitNum: 10n ** 22n, unitDen: 3_180_000_000n };

/** Launch rates: the 25% Instant Redeem Fee is taken after the 20% Yield Fee (ticket 31). */
const IF = 2_500;
const YF = 2_000;

describe("Instant Redeem payout (tesoro_core instant_payout)", () => {
  it("floors the Gemas' value, then pays it after both fees with one floor", () => {
    // 1,000 Gemas = $10 = 66,666,666.67 lamports -> 66,666,666 -> x 0.8 x 0.75 = 39,999,999.6 -> 39,999,999
    expect(instantPayoutFor(sol, 1_000n, IF, YF)).toBe(39_999_999n);
    expect(instantPayoutFor(sol, 1_000n, 0, 0)).toBe(66_666_666n);
    expect(instantPayoutFor({ unitNum: 5n, unitDen: 3n }, 3n, IF, YF)).toBe(3n);
    expect(instantPayoutFor({ unitNum: 1n, unitDen: 0n }, 3n, IF, YF)).toBe(0n);
  });

  it("inverts exactly: the most Gemas a payout limit allows, and no more", () => {
    for (const source of [sol, eth, { unitNum: 7n, unitDen: 3n }, { unitNum: 1n, unitDen: 1n }]) {
      for (const cap of [1n, 2n, 9n, 649n, 650n, 651n, 43_333_332n, 43_333_333n, 10n ** 12n]) {
        const g = maxInstantGemas(source, cap, IF, YF);
        expect(instantPayoutFor(source, g, IF, YF), `${source.unitNum}/${source.unitDen} cap ${cap}`).toBeLessThanOrEqual(cap);
        expect(instantPayoutFor(source, g + 1n, IF, YF), `${source.unitNum}/${source.unitDen} cap ${cap} +1`).toBeGreaterThan(cap);
      }
    }
    expect(maxInstantGemas(sol, 0n, IF, YF)).toBe(0n);
    expect(maxInstantGemas({ unitNum: 0n, unitDen: 1n }, 5n, IF, YF)).toBe(0n);
  });

  it("covers the treasury vault in simSOL the way the program does: shares floor(payout * 1e9 / rate) must fit", () => {
    const rate = 1_250_000_000n;
    for (const shares of [0n, 1n, 799n, 10n ** 9n, 12_345_678_901n]) {
      const cap = solPayoutCapacity(shares, rate);
      expect((cap * 1_000_000_000n) / rate).toBeLessThanOrEqual(shares);
      expect(((cap + 1n) * 1_000_000_000n) / rate).toBeGreaterThan(shares);
    }
    expect(solPayoutCapacity(5n, 0n)).toBe(0n);
  });
});

describe("planInstant", () => {
  const rows = [
    { key: "a", capKey: "SOL", free: 100_000n, ...sol },
    { key: "b", capKey: "SOL", free: 50_000n, ...sol },
    { key: "c", capKey: "0xvault", free: 1_000n, ...eth },
  ];

  it("sells every free Gema while the treasuries can pay", () => {
    const plan = planInstant(rows, new Map([["SOL", 10n ** 12n], ["0xvault", 10n ** 21n]]), IF, YF);
    expect(plan.map((l) => [l.key, l.gemas])).toEqual([["a", 100_000n], ["b", 50_000n], ["c", 1_000n]]);
    expect(plan[0].payout).toBe(instantPayoutFor(sol, 100_000n, IF, YF));
  });

  it("stops at the treasury's limit and leaves the rest to the next holding of the same treasury", () => {
    const cap = instantPayoutFor(sol, 120_000n, IF, YF);
    const plan = planInstant(rows, new Map([["SOL", cap]]), IF, YF);
    expect(plan.map((l) => [l.key, l.gemas])).toEqual([["a", 100_000n], ["b", maxInstantGemas(sol, cap - plan[0].payout, IF, YF)]]);
    expect(plan.reduce((s, l) => s + l.payout, 0n)).toBeLessThanOrEqual(cap);
  });

  it("sells nothing from a treasury that is missing or empty", () => {
    expect(planInstant(rows, new Map(), IF, YF)).toEqual([]);
    expect(planInstant(rows, new Map([["SOL", 0n]]), IF, YF)).toEqual([]);
  });
});

describe("Treasury decoders: a wrong size is absent", () => {
  const treasury = Buffer.alloc(TREASURY_LEN);
  treasury.writeUInt16LE(2_000, 11);
  treasury.writeUInt16LE(3_500, 13);

  it("reads the rates and falls back to the launch rates", () => {
    expect(parseTreasury(treasury)).toEqual({ yieldFeeBps: 2_000, instantFeeBps: 2_500 });
    expect(ratesOf(null)).toEqual(DEFAULT_RATES);
    expect(ratesOf({ yieldFeeBps: 1_000, instantFeeBps: 2_000 })).toEqual({ yieldFeeBps: 1_000, instantFeeBps: 2_000 });
    expect(DEFAULT_RATES).toEqual({ yieldFeeBps: 2_000, instantFeeBps: 2_500 });
  });

  it("returns null for any other size, never throws", () => {
    expect(parseTreasury(treasury.subarray(0, TREASURY_LEN - 1))).toBeNull();
    expect(parseTreasury(Buffer.alloc(TREASURY_LEN + 1))).toBeNull();
    expect(parseTreasury(Buffer.alloc(0))).toBeNull();
  });

  it("reads the vault's simSOL balance from a token account", () => {
    const token = Buffer.alloc(165);
    token.writeBigUInt64LE(8_000_000_000n, 64);
    expect(parseVaultShares(token)).toBe(8_000_000_000n);
    expect(parseVaultShares(Buffer.alloc(10))).toBeNull();
  });

  it("reads a VaultTreasury: the reported balance less payouts recorded since the report", () => {
    const d = Buffer.alloc(VAULT_TREASURY_LEN);
    expect(VAULT_TREASURY_LEN).toBe(101);
    d.writeBigUInt64LE(5n * 10n ** 18n, 44);
    d.writeBigUInt64LE(10n ** 18n, 60);
    d.writeBigUInt64LE(3n * 10n ** 18n, 76);
    d.writeBigUInt64LE(1_700_000_000n, 92);
    expect(parseVaultTreasury(d)).toEqual({ balance: 5n * 10n ** 18n, paidAtReport: 10n ** 18n, instantRecorded: 3n * 10n ** 18n, reportTime: 1_700_000_000n, available: 3n * 10n ** 18n });
    d.writeBigUInt64LE(9n * 10n ** 18n, 76);
    expect(parseVaultTreasury(d)?.available).toBe(0n);
    expect(parseVaultTreasury(d.subarray(0, VAULT_TREASURY_LEN - 1))).toBeNull();
    expect(parseVaultTreasury(Buffer.alloc(VAULT_TREASURY_LEN + 1))).toBeNull();
  });

  it("availability saturates: paid ahead of recorded counts as nothing outstanding", () => {
    expect(vaultTreasuryAvailable(100n, 50n, 20n)).toBe(100n);
    expect(vaultTreasuryAvailable(100n, 0n, 30n)).toBe(70n);
    expect(vaultTreasuryAvailable(10n, 0n, 30n)).toBe(0n);
  });
});

describe("instantTryCap", () => {
  const view = { available: 0n, paidAtReport: 0n, instantRecorded: 30n };
  it("lets a press through when the vault's own balance would cover it", () => {
    expect(instantTryCap(view, 100n)).toBe(70n);
  });
  it("keeps the mirror when the vault holds no more, or was not read", () => {
    expect(instantTryCap({ ...view, available: 50n }, 60n)).toBe(50n);
    expect(instantTryCap(view, null)).toBe(0n);
    expect(instantTryCap(view, 10n)).toBe(0n);
  });
});

describe("replanInstant", () => {
  const line = (key: string, gemas: bigint): InstantLine => ({ key, gemas, payout: gemas * 2n });
  const confirmed = [line("a", 100n), line("b", 50n)];

  it("sends what was confirmed when the new plan is the same", () => {
    expect(replanInstant(confirmed, confirmed)).toEqual({ kind: "send", lines: confirmed });
  });

  it("never sends more than confirmed when the new plan is larger", () => {
    expect(replanInstant(confirmed, [line("a", 130n), line("b", 50n), line("c", 9n)])).toEqual({ kind: "send", lines: confirmed });
  });

  it("asks again with the new amount when any line shrank", () => {
    expect(replanInstant(confirmed, [line("a", 80n), line("b", 50n)])).toEqual({ kind: "smaller", lines: [line("a", 80n), line("b", 50n)], gemas: 130n });
  });

  it("asks again with the capped amount when one line shrank and another grew", () => {
    expect(replanInstant(confirmed, [line("a", 60n), line("b", 70n)])).toEqual({ kind: "smaller", lines: [line("a", 60n), line("b", 50n)], gemas: 110n });
  });

  it("reports nothing left when no line survives", () => {
    expect(replanInstant(confirmed, [])).toEqual({ kind: "none" });
  });
});

describe("instantUnavailable", () => {
  it("is available when the Treasury exists and something can be paid", () => {
    expect(instantUnavailable({ setUp: true, payableRows: 1 })).toBeNull();
  });
  it("says Tesoro has not opened it before the Treasury exists", () => {
    expect(instantUnavailable({ setUp: false, payableRows: 0 })).toBe(INSTANT_NOT_OPEN);
  });
  it("is unavailable right now when the Treasury cannot pay any of the Gemas", () => {
    const reason = instantUnavailable({ setUp: true, payableRows: 0 });
    expect(reason).toBe(INSTANT_UNAVAILABLE_BODY);
    expect(reason).toContain("full value");
  });
});

describe("Treasury and custody layouts (ticket 31: no fee claim on open Positions)", () => {
  it("keeps the Treasury's size: the retired fee counter stays in place", () => {
    const t = Buffer.alloc(TREASURY_LEN);
    t.writeUInt16LE(2_000, 11);
    t.writeUInt16LE(2_500, 13);
    expect(TREASURY_LEN).toBe(8 + 3 + 2 + 2 + 32 + 32 + 3 * 8 + 8 + 32);
    expect(parseTreasury(t)).toEqual({ yieldFeeBps: 2_000, instantFeeBps: 2_500 });
    expect(parseTreasury(Buffer.alloc(TREASURY_LEN - 8))).toBeNull();
  });

  it("reads the route after the custody's principal, its retired fee totals and open-Position count", () => {
    const c = Buffer.alloc(NATIVE_CUSTODY_LEN);
    c.writeBigUInt64LE(77n, 8 + 2 + 96 + 64 + 8);
    expect(parseNativeRoute(c)?.treasuryShares).toBe(77n);
    expect(parseNativeRoute(c.subarray(1))).toBeNull();
  });
});
