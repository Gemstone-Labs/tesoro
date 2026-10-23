// Storybook: the Block Burst driver reports what the story says (`parameters.screen.burst`); it sends nothing.
import { useState } from "react";
import type { BurstView } from "../../../../../src/games/block-puzzle/useBurstMatch";
import { screenData } from "../../../../../stories/screens/support/screen";

export type { BurstView, Stage } from "../../../../../src/games/block-puzzle/useBurstMatch";

const IDLE: BurstView = {
  stage: "waiting",
  match: null,
  seat: 0,
  assignment: null,
  table: null,
  clock: null,
  run: null,
  elsewhere: false,
  ownOver: false,
  reason: null,
  result: null,
  note: "",
  error: null,
  sigs: [],
  refundable: false,
  commit: null,
  reconnecting: false,
};

export function useBurstMatch() {
  const story = screenData().burst;
  // A clock with `at: -1` starts when the story mounts, so a countdown does not begin before anyone looks.
  const [mounted] = useState(() => performance.now());
  const clock = story?.clock && story.clock.at < 0 ? { ...story.clock, at: mounted } : story?.clock;
  return { view: { ...IDLE, ...story, ...(clock ? { clock } : {}) }, tick: async () => {} };
}
