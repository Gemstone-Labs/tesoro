import { describe, expect, it } from "vitest";
import { quoteNativeAdvance } from "@/lib/chain/native";
import { DEPOSIT_PACKS, PACK_MONTHS, packFor, quotePack, usdToLamports, type PackMarket } from "./packs";

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
    // $100 at 7% for a year, 80% of it, $0.01 a Gema: about 560.
    expect(q.gemas).toBeGreaterThanOrEqual(555);
    expect(q.gemas).toBeLessThanOrEqual(560);
  });

  it("takes the checkout fee from the deposit before locking", () => {
    const free = quotePack(DEPOSIT_PACKS[2], m, 0);
    const fee = quotePack(DEPOSIT_PACKS[2], m, 100);
    expect(fee.feeUsd).toBe(5);
    expect(fee.lockLamports).toBe(usdToLamports(495, m.priceMicroUsd));
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
