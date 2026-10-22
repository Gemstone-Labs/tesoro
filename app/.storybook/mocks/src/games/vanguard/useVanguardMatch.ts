// Storybook: the Vanguard driver reports what the story says (`parameters.screen.vanguard`); it sends nothing.
import { useEffect, useState } from "react";
import type { VanguardView } from "../../../../../src/games/vanguard/useVanguardMatch";
import { screenData } from "../../../../../stories/screens/support/screen";

export type { VanguardView, Stage } from "../../../../../src/games/vanguard/useVanguardMatch";

const IDLE: VanguardView = { stage: "waiting", match: null, seat: 0, battle: null, army: null, turnSeenAt: 0, note: "", error: null, sigs: [], busy: null, refundable: false, commit: null, reconnecting: false };
const done = async () => {};

export function useVanguardMatch() {
  const { later, refuse, ...data } = screenData().vanguard ?? {};
  const [swapped, setSwapped] = useState<{ battle: NonNullable<typeof later>["battle"]; army?: NonNullable<typeof later>["army"]; at: number } | null>(null);
  useEffect(() => {
    if (!later) return;
    const t = setTimeout(() => setSwapped({ battle: later.battle, army: later.army, at: Date.now() }), later.afterMs);
    return () => clearTimeout(t);
  }, [later]);
  const view = { ...IDLE, ...data, ...(swapped ? { battle: swapped.battle, ...(swapped.army ? { army: swapped.army } : {}), turnSeenAt: swapped.at } : {}) };
  // a story can have the rollup refuse every action, to show the piece going back
  const send = async () => {
    if (refuse) {
      await new Promise((r) => setTimeout(r, 600));
      throw new Error(refuse);
    }
  };
  return { view, move: send, power: send, twoStep: done, tick: done, run: done };
}
