import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES,
  TREASURY_LEN,
  VAULT_TREASURY_LEN,
  instantPayoutFor,
  maxInstantGemas,
  parseTreasury,
  parseVaultShares,
  parseVaultTreasury,
  planInstant,
  ratesOf,
  solPayoutCapacity,
} from "./fees";

/** 1 Gema = $0.01; SOL at $150: 1 Gema = 10^13 / 150,000,000 lamports. */
const sol = { unitNum: 10n ** 13n, unitDen: 150_000_000n };
/** ETH at $3,180 (18 decimals): 1 Gema = 10^22 / 3,180,000,000 wei. */
const eth = { unitNum: 10n ** 22n, unitDen: 3_180_000_000n };

describe("Instant Redeem payout (tesoro_core instant_redeem)", () => {
  it("floors the Gemas' value, then takes 65% of it, floored again", () => {
    // 1,000 Gemas = $10 = 66,666,666.67 lamports -> 66,666,666 -> 43,333,332.9 -> 43,333,332
    expect(instantPayoutFor(sol, 1_000n, 3_500)).toBe(43_333_332n);
    expect(instantPayoutFor(sol, 1_000n, 0)).toBe(66_666_666n);
    expect(instantPayoutFor({ unitNum: 5n, unitDen: 3n }, 3n, 3_500)).toBe(3n);
    expect(instantPayoutFor({ unitNum: 1n, unitDen: 0n }, 3n, 3_500)).toBe(0n);
  });

  it("inverts exactly: the most Gemas a payout limit allows, and no more", () => {
    for (const source of [sol, eth, { unitNum: 7n, unitDen: 3n }, { unitNum: 1n, unitDen: 1n }]) {
      for (const cap of [1n, 2n, 9n, 649n, 650n, 651n, 43_333_332n, 43_333_333n, 10n ** 12n]) {
        const g = maxInstantGemas(source, cap, 3_500);
        expect(instantPayoutFor(source, g, 3_500), `${source.unitNum}/${source.unitDen} cap ${cap}`).toBeLessThanOrEqual(cap);
        expect(instantPayoutFor(source, g + 1n, 3_500), `${source.unitNum}/${source.unitDen} cap ${cap} +1`).toBeGreaterThan(cap);
      }
    }
    expect(maxInstantGemas(sol, 0n, 3_500)).toBe(0n);
    expect(maxInstantGemas({ unitNum: 0n, unitDen: 1n }, 5n, 3_500)).toBe(0n);
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
    const plan = planInstant(rows, new Map([["SOL", 10n ** 12n], ["0xvault", 10n ** 21n]]), 3_500);
    expect(plan.map((l) => [l.key, l.gemas])).toEqual([["a", 100_000n], ["b", 50_000n], ["c", 1_000n]]);
    expect(plan[0].payout).toBe(instantPayoutFor(sol, 100_000n, 3_500));
  });

  it("stops at the treasury's limit and leaves the rest to the next holding of the same treasury", () => {
    const cap = instantPayoutFor(sol, 120_000n, 3_500);
    const plan = planInstant(rows, new Map([["SOL", cap]]), 3_500);
    expect(plan.map((l) => [l.key, l.gemas])).toEqual([["a", 100_000n], ["b", maxInstantGemas(sol, cap - plan[0].payout, 3_500)]]);
    expect(plan.reduce((s, l) => s + l.payout, 0n)).toBeLessThanOrEqual(cap);
  });

  it("sells nothing from a treasury that is missing or empty", () => {
    expect(planInstant(rows, new Map(), 3_500)).toEqual([]);
    expect(planInstant(rows, new Map([["SOL", 0n]]), 3_500)).toEqual([]);
  });
});

describe("Treasury decoders: a wrong size is absent", () => {
  const treasury = Buffer.alloc(TREASURY_LEN);
  treasury.writeUInt16LE(2_000, 11);
  treasury.writeUInt16LE(3_500, 13);

  it("reads the rates and falls back to the launch rates", () => {
    expect(parseTreasury(treasury)).toEqual({ yieldFeeBps: 2_000, instantFeeBps: 3_500 });
    expect(ratesOf(null)).toEqual(DEFAULT_RATES);
    expect(ratesOf({ yieldFeeBps: 1_000, instantFeeBps: 2_000 })).toEqual({ yieldFeeBps: 1_000, instantFeeBps: 2_000 });
    expect(DEFAULT_RATES).toEqual({ yieldFeeBps: 2_000, instantFeeBps: 3_500 });
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

  it("reads a VaultTreasury: what the vault reported in, less what Instant Redeems have recorded", () => {
    const d = Buffer.alloc(VAULT_TREASURY_LEN);
    d.writeBigUInt64LE(5n * 10n ** 18n, 44);
    d.writeBigUInt64LE(10n ** 18n, 60);
    expect(parseVaultTreasury(d)).toEqual({ reportedIn: 5n * 10n ** 18n, instantRecorded: 10n ** 18n, available: 4n * 10n ** 18n });
    d.writeBigUInt64LE(6n * 10n ** 18n, 60);
    expect(parseVaultTreasury(d)?.available).toBe(0n);
    expect(parseVaultTreasury(d.subarray(0, VAULT_TREASURY_LEN - 1))).toBeNull();
    expect(parseVaultTreasury(Buffer.alloc(8 + 4 + 32 + 16 + 16 + 17))).toBeNull();
  });
});
