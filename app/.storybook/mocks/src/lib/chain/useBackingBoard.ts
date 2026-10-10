// Storybook: loading and failed reads for the Backing board; otherwise the real hook reads the demo board.
import * as real from "../../../../../src/lib/chain/useBackingBoard";
import { screenData } from "../../../../../stories/screens/support/screen";

export const { recordFromMatches, recordShort, recordText, timeLeft, shortKey } = real;
export type { BackingData } from "../../../../../src/lib/chain/useBackingBoard";

export function useBackingBoard(): real.BackingData {
  const board = real.useBackingBoard();
  const mode = screenData().board;
  if (mode === "loading") return { board: null, loading: true, error: null, refresh: board.refresh };
  if (mode === "error") return { board: null, loading: false, error: "Couldn’t load the Requests. Check your connection and try again.", refresh: board.refresh };
  return board;
}
