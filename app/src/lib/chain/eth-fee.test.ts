import { describe, expect, it } from "vitest";
import { CLUSTERS } from "@/lib/cluster-settings";
import { OPEN_GAS_UNITS, assertCanAffordOpen, playerPaysGas, quoteOpenCost } from "./eth-fee";

const GWEI = 10n ** 9n;

describe("quoteOpenCost", () => {
  it("adds the gas of approve + open to the LayerZero fee with headroom", () => {
    const q = quoteOpenCost({ lzQuoteWei: 1_000_000n, gasPriceWei: 20n * GWEI, needsApprove: true });
    expect(q.lzFeeWei).toBe(1_200_000n); // quote + 20% headroom, the excess is refunded
    expect(q.gasUnits).toBe(OPEN_GAS_UNITS.approve + OPEN_GAS_UNITS.open);
    expect(q.gasWei).toBe(q.gasUnits * 20n * GWEI);
    expect(q.totalWei).toBe(q.gasWei + q.lzFeeWei);
  });

  it("skips the approval gas when the allowance already covers the amount", () => {
    const q = quoteOpenCost({ lzQuoteWei: 5n, gasPriceWei: GWEI, needsApprove: false });
    expect(q.gasUnits).toBe(OPEN_GAS_UNITS.open);
  });
});

describe("assertCanAffordOpen", () => {
  const q = quoteOpenCost({ lzQuoteWei: 10n ** 15n, gasPriceWei: 10n * GWEI, needsApprove: true });
  it("passes with enough native token and names the shortfall otherwise", () => {
    expect(() => assertCanAffordOpen(q.totalWei, q, "ETH")).not.toThrow();
    expect(() => assertCanAffordOpen(q.totalWei - 1n, q, "ETH")).toThrow(/ETH/);
  });
  it("keeps the amount in the native token out of the check when the Player locks wstETH", () => {
    expect(() => assertCanAffordOpen(0n, q, "ETH")).toThrow(/gas/i);
  });
});

describe("playerPaysGas", () => {
  it("is true on mainnet only: test mode keeps the relayer top-up", () => {
    expect(playerPaysGas(CLUSTERS.mainnet)).toBe(true);
    expect(playerPaysGas(CLUSTERS.test)).toBe(false);
  });
});
