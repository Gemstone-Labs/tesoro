import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPOSIT_PACKS } from "@/lib/deposit/packs";

describe("Buy Gemas lists the packs cheapest first on every screen", () => {
  it("the packs are in price order", () => {
    const prices = DEPOSIT_PACKS.map((p) => p.usd);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("no style moves a pack card out of that order", () => {
    expect(readFileSync(join(__dirname, "deposit.css"), "utf8")).not.toMatch(/(^|[\s;{])order\s*:/);
  });
});
