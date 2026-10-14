// Storybook: the Hold'em driver reports what the story says (`parameters.screen.holdem`); it sends nothing.
import type { HoldemView } from "../../../../../src/games/holdem/useHoldemMatch";
import { screenData } from "../../../../../stories/screens/support/screen";

export type { HoldemView, Stage } from "../../../../../src/games/holdem/useHoldemMatch";

const IDLE: HoldemView = { stage: "waiting", match: null, seat: 0, table: null, hole: null, note: "", error: null, sigs: [], busy: null, refundable: false, commit: null };
const done = async () => {};

export function useHoldemMatch() {
  const view = { ...IDLE, ...screenData().holdem };
  return { view, act: done, claimTimeout: done, tick: done, run: done };
}
