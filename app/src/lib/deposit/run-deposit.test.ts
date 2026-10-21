import { describe, expect, it, vi } from "vitest";
import type { CheckoutContext, DepositCheckout } from "./checkout";
import { DEPOSIT_PACKS, type PackQuote } from "./packs";
import { runPackDeposit, type DepositPhase } from "./run-deposit";

const quote: PackQuote = { pack: DEPOSIT_PACKS[0], lockLamports: 900_000_000n, feeUsd: 0, gemas: 560 };
const ctx = {} as CheckoutContext;
const lock = { positionPubkey: "P", gemas: 560, signatures: ["sig"] };

describe("running a pack deposit", () => {
  it("pays, then adds the deposit", async () => {
    const fund = vi.fn(async () => undefined);
    const openLock = vi.fn(async () => lock);
    const phases: DepositPhase[] = [];
    const out = await runPackDeposit(ctx, quote, { funded: false }, (p) => phases.push(p), { checkout: { id: "test", feeBps: 0, fund } as DepositCheckout, openLock });
    expect(out.gemas).toBe(560);
    expect(phases).toEqual(["paying", "adding"]);
    expect(fund).toHaveBeenCalledWith(ctx, 900_000_000n);
    expect(openLock).toHaveBeenCalledWith(ctx, { amountLamports: 900_000_000n });
  });

  it("retries only the deposit when the money already arrived", async () => {
    const fund = vi.fn(async () => undefined);
    const openLock = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(lock);
    const deps = { checkout: { id: "test", feeBps: 0, fund } as DepositCheckout, openLock };
    const progress = { funded: false };
    await expect(runPackDeposit(ctx, quote, progress, () => undefined, deps)).rejects.toThrow("busy");
    expect(progress.funded).toBe(true);
    const phases: DepositPhase[] = [];
    await runPackDeposit(ctx, quote, progress, (p) => phases.push(p), deps);
    expect(fund).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["adding"]);
  });

  it("does not claim the money arrived when paying failed", async () => {
    const progress = { funded: false };
    const checkout = { id: "test", feeBps: 0, fund: async () => { throw new Error("no"); } } as DepositCheckout;
    await expect(runPackDeposit(ctx, quote, progress, () => undefined, { checkout, openLock: vi.fn() })).rejects.toThrow("no");
    expect(progress.funded).toBe(false);
  });

  it("refuses when there is no checkout", async () => {
    await expect(runPackDeposit(ctx, quote, { funded: false }, () => undefined, { checkout: null, openLock: vi.fn() })).rejects.toThrow(/coming soon/);
  });
});
