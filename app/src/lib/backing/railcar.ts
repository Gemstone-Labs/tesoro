import { ENTRY_GEMAS } from "@/games/railcar/chain";
import { placeSharesBps } from "@/games/railcar/engine";
import { planPayout } from "@/games/railcar/payout";
import { seatSplit } from "@/games/railcar/view";
import type { BackedGame } from "./games";

const ENTRY = BigInt(ENTRY_GEMAS);

/**
 * What a Railcar Offer means for each side, by the spec's worked example (5 Players, Ana Jumps early at 8 s): last off
 * wins 103 after fees on top of the entry. A place returns the Backer's entry first, then the winnings split by the
 * Offer. Out of the last three (an early Jump, or aboard at Impact) the Backer loses the entry and the Player nothing:
 * no Jump is refunded since rules round 2 (decisions Q40).
 */
export function railcarOfferOutcomes(shareBps: number) {
  const { won } = planPayout({ entry: ENTRY, seated: 5, shares: placeSharesBps(3), refunded: 0n, platformBps: 200, studioBps: 300, leaderboardBps: 100 });
  const exampleWon = won[0];
  const split = seatSplit({ gets: ENTRY + exampleWon, entry: ENTRY, placed: true, shareBps });
  return {
    exampleWon,
    place: { backer: split.backerGets - ENTRY, player: split.playerGets },
    unplaced: { backer: -ENTRY, player: 0n },
  };
}

/** The terms a backed Player reads on their accepted Backing. */
export const backingTerms = (game: BackedGame, sharePct: number): string =>
  game === "railcar"
    ? `Their Gemas fund your entry. Only the last three off are paid: if you Jump earlier or are aboard when the bomb goes off, they lose it and you owe nothing. If you place, their entry returns first, then you keep ${sharePct}% of the winnings.`
    : `Their Gemas fund your entry. If you lose, they bear it and you owe nothing. If you win, their entry returns first, then you keep ${sharePct}% of what remains.`;
