// Storybook: a Match can start its run without a rollup; every other read still goes through the (blocked) real client.
import * as real from "../../../../../src/lib/chain/client";

import { screenData } from "../../../../../stories/screens/support/screen";

export const { getHoldem } = real;

let duel: ReturnType<typeof real.getTradingDuel> | null = null;

/** Spectators of a finished Duel read both Books from the story. */
export function getTradingDuel() {
  duel ??= Object.assign(Object.create(real.getTradingDuel()), {
    readDuelOnBase: async () => screenData().duel?.duel ?? null,
    readBooksOnBase: async () => screenData().duel?.finalBooks ?? null,
  });
  return duel!;
}

let wrapped: ReturnType<typeof real.getChain> | null = null;

export function getChain() {
  wrapped ??= Object.assign(Object.create(real.getChain()), {
    beginRun: async () => ({ sig: "demo-begin", seed: 0x5eed1234n }),
    finish: async () => "demo-finish",
  });
  return wrapped!;
}
