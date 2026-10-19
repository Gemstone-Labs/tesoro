import { describe, expect, it } from "vitest";
import { pendingBySource } from "./account";
import type { GemaHolding } from "./mock/types";

const holding = (advanceId: string, positionId: string, chain: "SOL" | "ETH", owner: string, gemas: number, accruedShare: number): GemaHolding => ({
  source: { advanceId, positionId, chain, asset: chain, owner },
  gemas,
  accruedShare,
  own: owner === "Your Lock",
});

describe("pendingBySource", () => {
  it("keeps two Sources on the same chain apart, with their asset and Position", () => {
    const rows = pendingBySource([
      holding("adv-a", "pos-a", "SOL", "Your Lock", 1000, 0.25),
      holding("adv-b", "pos-b", "SOL", "Ab12…cd34's Lock", 500, 0),
      holding("adv-c", "pos-c", "ETH", "Ef56…gh78's Lock", 300, 0.5),
    ]);
    expect(rows).toEqual([
      { key: "adv-a", chain: "SOL", asset: "SOL", positionId: "pos-a", owner: "Your Lock", pending: 750, accruedShare: 0.25 },
      { key: "adv-b", chain: "SOL", asset: "SOL", positionId: "pos-b", owner: "Ab12…cd34's Lock", pending: 500, accruedShare: 0 },
      { key: "adv-c", chain: "ETH", asset: "ETH", positionId: "pos-c", owner: "Ef56…gh78's Lock", pending: 150, accruedShare: 0.5 },
    ]);
  });

  it("leaves out Sources that are fully redeemable", () => {
    expect(pendingBySource([holding("adv-a", "pos-a", "SOL", "Your Lock", 400, 1)])).toEqual([]);
  });

  it("sums holdings of one Source", () => {
    const rows = pendingBySource([
      holding("adv-a", "pos-a", "ETH", "Your Lock", 100, 0),
      holding("adv-a", "pos-a", "ETH", "Your Lock", 50, 0),
    ]);
    expect(rows.map((r) => r.pending)).toEqual([150]);
  });
});
