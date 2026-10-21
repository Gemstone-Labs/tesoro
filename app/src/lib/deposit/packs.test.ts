import { describe, expect, it } from "vitest";
import { quoteNativeAdvance } from "@/lib/chain/native";
import { DEPOSIT_PACKS, PACK_MONTHS, lamportsForGemas, packFor, quotePack, usdToLamports, type PackMarket } from "./packs";

const m: PackMarket = { priceMicroUsd: 110_000_000n, apyBps: 700, yieldFeeBps: 2_000 };

describe("deposit packs", () => {
  it("are Starter $100, Player $250, Pro $500 with a 12-month Length", () => {
    expect(DEPOSIT_PACKS.map((p) => [p.name, p.usd])).toEqual([["Starter", 100], ["Player", 250], ["Pro", 500]]);
    expect(PACK_MONTHS).toBe(12);
  });

  it("converts dollars to SOL at the price", () => {
    expect(usdToLamports(110, 110_000_000n)).toBe(1_000_000_000n);
    expect(usdToLamports(100, 0n)).toBe(0n);
  });

  it("issues what the Advance rule gives for the Lock: 12 months of yield at 80%", () => {
    const q = quotePack(DEPOSIT_PACKS[0], m, 0);
    expect(q.gemas).toBe(Number(quoteNativeAdvance(q.lockLamports, 700, 12, m.priceMicroUsd, 2_000).gemas));
    // $100 at 7% for a year, 80% of it, $0.01 a Gema: 560.
    expect(q.gemas).toBe(560);
  });

  it("lands on the round number for every pack and price; the dust Tesoro adds stays under 20 cents", () => {
    for (const priceMicroUsd of [110_000_000n, 187_340_000n, 93_123_457n]) {
      const mk = { ...m, priceMicroUsd };
      expect(DEPOSIT_PACKS.map((p) => quotePack(p, mk, 0).gemas)).toEqual([560, 1_400, 2_800]);
      for (const p of DEPOSIT_PACKS) {
        const extra = quotePack(p, mk, 0).lockLamports - usdToLamports(p.usd, priceMicroUsd);
        expect(extra * priceMicroUsd).toBeLessThan(200_000n * 1_000_000_000n); // under $0.20
      }
    }
  });

  it("never issues a Gema less than promised when the price ticks down a little before the deposit lands", () => {
    // The founder paid $250, saw 1,400 and got 1,399: the Lock was sized exactly on the line.
    for (const priceMicroUsd of [110_000_000n, 187_340_000n, 93_123_457n]) {
      for (const p of DEPOSIT_PACKS) {
        const q = quotePack(p, { ...m, priceMicroUsd }, 0);
        const ticked = (priceMicroUsd * 99_970n) / 100_000n; // 0.03% lower when the Advance is taken
        const issued = (price: bigint) => Number(quoteNativeAdvance(q.lockLamports, 700, 12, price, 2_000).gemas);
        expect(issued(ticked)).toBeGreaterThanOrEqual(q.gemas);
        expect(issued(priceMicroUsd)).toBeLessThanOrEqual(q.gemas + 1);
      }
    }
  });

  it("sizes a Lock for a number of Gemas, with room for a small price tick", () => {
    for (const target of [1n, 560n, 1_400n, 2_800n, 12_345n]) {
      const lamports = lamportsForGemas(target, m);
      const at = (l: bigint, price = m.priceMicroUsd) => quoteNativeAdvance(l, 700, 12, price, 2_000).gemas;
      expect(at(lamports)).toBeGreaterThanOrEqual(target);
      expect(at(lamports, (m.priceMicroUsd * 99_970n) / 100_000n)).toBeGreaterThanOrEqual(target);
    }
  });

  it("takes the checkout fee from the deposit before locking", () => {
    const free = quotePack(DEPOSIT_PACKS[2], m, 0);
    const fee = quotePack(DEPOSIT_PACKS[2], m, 100);
    expect(fee.feeUsd).toBe(5);
    expect(fee.gemas).toBe(2_772);
    expect(fee.lockLamports).toBeGreaterThanOrEqual(usdToLamports(495, m.priceMicroUsd));
    expect(fee.gemas).toBeLessThan(free.gemas);
  });

  it("highlights the smallest pack that covers a game's shortfall, else the largest", () => {
    const quotes = DEPOSIT_PACKS.map((p) => quotePack(p, m, 0));
    expect(packFor(0, quotes)).toBeNull();
    expect(packFor(500, quotes)).toBe("starter");
    expect(packFor(1_000, quotes)).toBe("player");
    expect(packFor(100_000, quotes)).toBe("pro");
  });
});
