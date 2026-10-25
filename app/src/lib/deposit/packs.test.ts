import { describe, expect, it } from "vitest";
import { quoteNativeAdvance } from "@/lib/chain/native";
import { DEPOSIT_PACKS, PACK_MONTHS, lamportsForGemas, packFor, quotePack, usdToLamports, type PackMarket } from "./packs";

const m: PackMarket = { priceMicroUsd: 110_000_000n, apyBps: 700 };

describe("deposit packs", () => {
  it("are Starter $100, Player $250, Pro $500 with a 12-month Length", () => {
    expect(DEPOSIT_PACKS.map((p) => [p.name, p.usd])).toEqual([["Starter", 100], ["Player", 250], ["Pro", 500]]);
    expect(PACK_MONTHS).toBe(12);
  });

  it("converts dollars to SOL at the price", () => {
    expect(usdToLamports(110, 110_000_000n)).toBe(1_000_000_000n);
    expect(usdToLamports(100, 0n)).toBe(0n);
  });

  it("issues what the Advance rule gives for the Lock: 12 months of the whole yield", () => {
    const q = quotePack(DEPOSIT_PACKS[0], m, 0);
    expect(q.gemas).toBe(Number(quoteNativeAdvance(q.lockLamports, 700, 12, m.priceMicroUsd).gemas));
    // $100 at 7% for a year, $0.01 a Gema: 700.
    expect(q.gemas).toBe(700);
  });

  it("lands exactly on the round number for every pack and price; the dust Tesoro adds stays under 20 cents", () => {
    for (const priceMicroUsd of [110_000_000n, 187_340_000n, 93_123_457n]) {
      const mk = { ...m, priceMicroUsd };
      expect(DEPOSIT_PACKS.map((p) => quotePack(p, mk, 0).gemas)).toEqual([700, 1_750, 3_500]);
      for (const p of DEPOSIT_PACKS) {
        const q = quotePack(p, mk, 0);
        expect(Number(quoteNativeAdvance(q.lockLamports, 700, 12, priceMicroUsd).gemas)).toBe(q.gemas);
        const extra = q.lockLamports - usdToLamports(p.usd, priceMicroUsd);
        expect(extra * priceMicroUsd).toBeLessThan(200_000n * 1_000_000_000n); // under $0.20
      }
    }
  });

  it("sizes the Lock right on the line: one lamport less would issue a Gema less", () => {
    for (const priceMicroUsd of [110_000_000n, 187_340_000n, 93_123_457n]) {
      for (const target of [1n, 700n, 1_750n, 3_500n, 12_345n]) {
        const lamports = lamportsForGemas(target, { ...m, priceMicroUsd });
        const at = (l: bigint) => quoteNativeAdvance(l, 700, 12, priceMicroUsd).gemas;
        expect(at(lamports)).toBeGreaterThanOrEqual(target);
        expect(at(lamports - 1n)).toBeLessThan(target);
      }
    }
  });

  it("a price tick down refuses the Advance (the floor) instead of issuing a Gema less", () => {
    for (const p of DEPOSIT_PACKS) {
      const q = quotePack(p, m, 0);
      const ticked = (m.priceMicroUsd * 99_970n) / 100_000n;
      expect(Number(quoteNativeAdvance(q.lockLamports, 700, 12, ticked).gemas)).toBeLessThan(q.gemas);
    }
  });

  it("takes the checkout fee from the deposit before locking", () => {
    const free = quotePack(DEPOSIT_PACKS[2], m, 0);
    const fee = quotePack(DEPOSIT_PACKS[2], m, 100);
    expect(fee.feeUsd).toBe(5);
    expect(fee.gemas).toBe(3_465);
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
