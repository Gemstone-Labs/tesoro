// Storybook: open Queue Matches per Game come from the story (`parameters.screen.queueDepth`).
import type { GameId } from "../../../../../src/lib/mock";
import { screenData } from "../../../../../stories/screens/support/screen";

export function useQueueDepth(): Record<GameId, number> {
  return screenData().queueDepth ?? { "block-puzzle": 3, holdem: 2, "trading-duel": 1 };
}
