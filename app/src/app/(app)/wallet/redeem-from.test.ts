import { describe, expect, it } from "vitest";
import { redeemFromLine } from "./MoneySheets";

const row = (prize = false) => ({ prize });

describe("Redeem sheet: where the Gemas come from", () => {
  it("counts Season prizes apart from Locks", () => {
    expect(redeemFromLine([row(), row(), row(), row(), row(), row(true), row(true)])).toBe("From 5 Locks and 2 Season prizes");
  });
  it("says one of each in the singular", () => {
    expect(redeemFromLine([row(), row(true)])).toBe("From 1 Lock and 1 Season prize");
  });
  it("names only what is there", () => {
    expect(redeemFromLine([row(), row(), row()])).toBe("From 3 Locks");
    expect(redeemFromLine([row(true)])).toBe("From 1 Season prize");
  });
});
