import { describe, expect, it } from "vitest";
import { NATIVE_OPEN_GAS, nativeOpenValue, nativeStakeProblem, openChoices, quoteNativeStake } from "./eth-native";
import { quoteOpenCost } from "./eth-fee";

const E18 = 10n ** 18n;
const zap = "0x" + "2".repeat(40);

describe("openChoices", () => {
  it("offers the coin first and the token second when the vault has a zap", () => {
    expect(openChoices({ symbol: "kHYPE", zap: zap as never }, "HYPE")).toEqual([
      { with: "native", symbol: "HYPE" },
      { with: "token", symbol: "kHYPE" },
    ]);
    expect(openChoices({ symbol: "wstETH", zap: zap as never }, "ETH").map((c) => c.symbol)).toEqual(["ETH", "wstETH"]);
  });
  it("offers only the token without a zap (test mode, or not deployed yet)", () => {
    expect(openChoices({ symbol: "simETH" }, "ETH")).toEqual([{ with: "token", symbol: "simETH" }]);
  });
});

describe("quoteNativeStake", () => {
  it("quotes the token received from the rate and a slippage floor", () => {
    const q = quoteNativeStake({ stakeWei: 10n * E18, rate: 1_025n * 10n ** 15n });
    expect(q.lstOut).toBe((10n * E18 * E18) / (1_025n * 10n ** 15n));
    expect(q.minLst).toBe((q.lstOut * 9_950n) / 10_000n);
    expect(q.principalWei).toBeGreaterThan(10n * E18 - 2n);
    expect(q.principalWei).toBeLessThanOrEqual(10n * E18);
  });
  it("flags a stake under Kinetiq's minimum with a plain message", () => {
    const q = quoteNativeStake({ stakeWei: 2n * E18, rate: E18, minStakeWei: 5n * E18 });
    expect(q.belowMinimum).toBe(true);
    expect(nativeStakeProblem(q, 5n * E18, "HYPE")).toBe("The smallest HYPE stake is 5 HYPE.");
    expect(nativeStakeProblem(quoteNativeStake({ stakeWei: 5n * E18, rate: E18, minStakeWei: 5n * E18 }), 5n * E18, "HYPE")).toBeNull();
  });
  it("is zero for an empty amount", () => {
    expect(quoteNativeStake({ stakeWei: 0n, rate: E18 }).lstOut).toBe(0n);
  });
});

describe("the call and its cost", () => {
  it("sends the stake plus the LayerZero fee as msg.value", () => {
    expect(nativeOpenValue(3n * E18, 12n)).toBe(3n * E18 + 12n);
  });
  it("prices gas for one transaction and no approval", () => {
    const q = quoteOpenCost({ lzQuoteWei: 100n, gasPriceWei: 10n, needsApprove: false, gasUnits: NATIVE_OPEN_GAS });
    expect(q.gasUnits).toBe(NATIVE_OPEN_GAS);
    expect(q.totalWei).toBe(NATIVE_OPEN_GAS * 10n + 120n);
  });
});
