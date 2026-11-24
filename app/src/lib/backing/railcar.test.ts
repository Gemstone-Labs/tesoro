import { describe, expect, it } from "vitest";
import { backingTerms, railcarOfferOutcomes } from "./railcar";

describe("what a Railcar Offer means for the Backer and the Player (the spec's worked example)", () => {
  it("last off of 5 wins 103 after fees: at 40% to the Player, the Backer nets +62 and the Player +41", () => {
    const o = railcarOfferOutcomes(4_000);
    expect(o.exampleWon).toBe(103n);
    expect(o.place).toEqual({ backer: 62n, player: 41n });
  });

  it("out of the last three, an early Jump or aboard at Impact, the Backer loses 100 and the Player nothing (no Early-jump refund since rules round 2)", () => {
    const o = railcarOfferOutcomes(4_000);
    expect(o.unplaced).toEqual({ backer: -100n, player: 0n });
    expect(o).not.toHaveProperty("early");
  });

  it("the Player's share rounds down, the Backer keeps the rest", () => {
    expect(railcarOfferOutcomes(9_000).place).toEqual({ backer: 11n, player: 92n });
  });

  it("the terms a backed Player reads: Railcar names the last three, the early Jump and the bomb, head-to-head the win and the loss", () => {
    expect(backingTerms("railcar", 40)).toBe(
      "Their Gemas fund your entry. Only the last three off are paid: if you Jump earlier or are aboard when the bomb goes off, they lose it and you owe nothing. If you place, their entry returns first, then you keep 40% of the winnings.",
    );
    expect(backingTerms("railcar", 40)).not.toMatch(/refund/i);
    expect(backingTerms("holdem", 40)).toBe("Their Gemas fund your entry. If you lose, they bear it and you owe nothing. If you win, their entry returns first, then you keep 40% of what remains.");
  });
});
