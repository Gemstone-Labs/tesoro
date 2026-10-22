import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { coreIx } from "./core-ix";
import { advanceFloorOf, quoteEthAdvance } from "./eth";
import { PRICE_MOVED, plainError } from "@/lib/errors";

describe("the Gemas floor of an ETH or HYPE Advance", () => {
  const k = () => Keypair.generate().publicKey;
  it("reads min_gemas from the end of take_advance and take_advance_onchain data", () => {
    const common = Object.fromEntries(["oracle", "owner_authority", "config", "treasury", "owner_account", "protections", "position", "source", "book", "basket", "spill", "economy"].map((n) => [n, k()]));
    const a = coreIx("take_advance", common, { horizon_months: 6, price_micro_usd: 3_000_000_000n, min_gemas: 12_345n });
    expect(advanceFloorOf(a.data)).toBe(12_345n);
    const b = coreIx("take_advance_onchain", { ...common, onchain_price: k(), price_feed: k() }, { horizon_months: 6, min_gemas: 99n });
    expect(advanceFloorOf(b.data)).toBe(99n);
  });

  it("quotes whole Gemas, floored, so the floor never exceeds what the program issues", () => {
    const q = quoteEthAdvance(10n ** 18n, 500, 6, 3_000_000_000n);
    expect(q.gemas).toBe((q.projectedUnits * 3_000_000_000n) / 10n ** 22n);
  });
});

describe("a refused floor", () => {
  it("is explained as a price move that took nothing", () => {
    expect(plainError(new Error("Transaction failed: custom program error: 0x179d"))).toBe(PRICE_MOVED);
    expect(plainError(new Error("Error Code: AdvanceBelowMinimum. Error Number: 6045."))).toBe(PRICE_MOVED);
  });
});
