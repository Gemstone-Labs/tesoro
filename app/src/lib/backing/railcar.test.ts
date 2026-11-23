import { describe, expect, it } from "vitest";
import { backingTerms, railcarOfferOutcomes } from "./railcar";

describe("what a Railcar Offer means for the Backer and the Player (the spec's worked example)", () => {
  it("last off of 5 wins 103 after fees: at 40% to the Player, the Backer nets +62 and the Player +41", () => {
    const o = railcarOfferOutcomes(4_000);
    expect(o.exampleWon).toBe(103n);
    expect(o.place).toEqual({ backer: 62n, player: 41n });
  });

  it("an early Jump returns nothing to the Backer (no Early-jump refund since rules round 2); aboard at Impact the Backer loses 100 and the Player nothing", () => {
    const o = railcarOfferOutcomes(4_000);
    expect(o.early).toEqual({ mostBack: 0n, leastBack: 0n, player: 0n });
    expect(o.aboard).toEqual({ backer: -100n, player: 0n });
  });

  it("the Player's share rounds down, the Backer keeps the rest", () => {
    expect(railcarOfferOutcomes(9_000).place).toEqual({ backer: 11n, player: 92n });
  });

  it("the terms a backed Player reads: Railcar names the early Jump and Impact, head-to-head the win and the loss", () => {
    expect(backingTerms("railcar", 40)).toBe(
      "Their Gemas fund your entry. Aboard at Impact, they bear it and you owe nothing; an early Jump's refund goes back to them. If you place, their entry returns first, then you keep 40% of the winnings.",
    );
    expect(backingTerms("holdem", 40)).toBe("Their Gemas fund your entry. If you lose, they bear it and you owe nothing. If you win, their entry returns first, then you keep 40% of what remains.");
  });
});
