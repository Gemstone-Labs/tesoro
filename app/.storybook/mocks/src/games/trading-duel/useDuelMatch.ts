// Storybook: the Trading Duel driver reports what the story says (`parameters.screen.duel`); it sends nothing.
import { ASSETS } from "../../../../../src/games/trading-duel/chain";
import type { DuelView } from "../../../../../src/games/trading-duel/useDuelMatch";
import { screenData } from "../../../../../stories/screens/support/screen";

export type { DuelView, Stage } from "../../../../../src/games/trading-duel/useDuelMatch";

const IDLE: DuelView = { stage: "waiting", match: null, seat: 0, asset: ASSETS[0], duel: null, book: null, pending: {}, note: "", error: null, sigs: [], busy: null, refundable: false, clockOffsetMs: 0 };
const done = async () => {};

export function useDuelMatch() {
  const view = { ...IDLE, ...screenData().duel };
  return { view, pick: done, tick: done, run: done };
}
