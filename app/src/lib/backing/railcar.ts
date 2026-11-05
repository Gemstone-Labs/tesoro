import { ENTRY_GEMAS } from "@/games/railcar/chain";
import { placeSharesBps, refund } from "@/games/railcar/engine";
import { planPayout, seatSplit } from "@/games/railcar/view";
import type { BackedGame } from "./games";

const ENTRY = BigInt(ENTRY_GEMAS);
/** Ride ms of the last step of the Early-jump refund schedule that pays anything (5%, 90 to 100 s). */
const LAST_REFUND_MS = 95_000;

/**
 * What a Railcar Offer means for each side, by the spec's worked example (5 Players, Ana Jumps early at 25 s): last off
 * wins 313 after fees on top of the entry. A place returns the Backer's entry first, then the winnings split by the
 * Offer; an early Jump's refund is the Backer's; aboard at Impact the Backer loses the entry and the Player nothing.
 */
export function railcarOfferOutcomes(shareBps: number) {
  const { won } = planPayout({ entry: ENTRY, seated: 5, shares: placeSharesBps(3), refunded: refund(ENTRY, 25_000), platformBps: 200, studioBps: 300, leaderboardBps: 100 });
  const exampleWon = won[0];
  const split = seatSplit({ gets: ENTRY + exampleWon, entry: ENTRY, placed: true, shareBps });
  return {
    exampleWon,
    place: { backer: split.backerGets - ENTRY, player: split.playerGets },
    early: { mostBack: refund(ENTRY, 0), leastBack: refund(ENTRY, LAST_REFUND_MS), player: 0n },
    aboard: { backer: -ENTRY, player: 0n },
  };
}

/** The terms a backed Player reads on their accepted Backing. */
export const backingTerms = (game: BackedGame, sharePct: number): string =>
  game === "railcar"
    ? `Their Gemas fund your entry. Aboard at Impact, they bear it and you owe nothing; an early Jump's refund goes back to them. If you place, their entry returns first, then you keep ${sharePct}% of the winnings.`
    : `Their Gemas fund your entry. If you lose, they bear it and you owe nothing. If you win, their entry returns first, then you keep ${sharePct}% of what remains.`;
