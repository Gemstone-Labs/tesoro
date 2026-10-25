// Storybook: open Queue Matches per Game come from the story (`parameters.screen.queueDepth`).
import type { QueueSeat } from "../../../../../src/lib/chain/read";
import type { GameId } from "../../../../../src/lib/mock";
import { screenData } from "../../../../../stories/screens/support/screen";

export type QueueSeats = Record<GameId, QueueSeat[]>;

const ENTRIES = [1000, 500, 1000, 100];

export function useQueueDepth(): Record<GameId, number> {
  return screenData().queueDepth ?? { "block-puzzle": 3, holdem: 2, "trading-duel": 1, vanguard: 1 };
}

/** Fake waiting Players, spread over the entries, one per story count. */
export function useQueue(): QueueSeats {
  const depth = useQueueDepth();
  const seats = (game: GameId) => Array.from({ length: depth[game] }, (_, i) => ({ player: `${game}-waiting-${i}`, funder: `${game}-waiting-${i}`, entry: ENTRIES[i % ENTRIES.length], asset: 0 }));
  return { "block-puzzle": seats("block-puzzle"), holdem: seats("holdem"), "trading-duel": seats("trading-duel"), vanguard: seats("vanguard") };
}
