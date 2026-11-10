import { describe, expect, it } from "vitest";
import { entryProblemOf, gemaTotals } from "./account";

describe("Gema totals with waiting Gemas", () => {
  it("counts waiting Gemas in what the Player owns, not in what an entry can spend", () => {
    const t = gemaTotals({ total: 1000, redeemable: 400, reserved: 100, waiting: 166 });
    expect(t.owned).toBe(1166);
    expect(t.total).toBe(1000);
    expect(t.available).toBe(900);
    expect(t.waiting).toBe(166);
  });
  it("the entry check does not count waiting Gemas", () => {
    const snap = { ownTotal: 300n, wonTotal: 100n, reservedTotal: 0n, ticketNeed: 0n };
    expect(entryProblemOf(snap, 500)).toBe("insufficient");
    expect(entryProblemOf(snap, 400)).toBeNull();
  });
});
