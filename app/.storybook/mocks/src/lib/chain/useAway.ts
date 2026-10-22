// Storybook: a story's `parameters.screen.away` puts the signed-in Player on a Break or Self-Exclusion; otherwise the real read.
import * as real from "../../../../../src/lib/chain/useAway";
import { awayView, DAY_SECS, MONTH_SECS } from "../../../../../src/lib/chain/protections";
import { screenData } from "../../../../../stories/screens/support/screen";

export * from "../../../../../src/lib/chain/useAway";

export function useAway(): ReturnType<typeof real.useAway> {
  const view = real.useAway();
  const away = screenData().away;
  if (!away) return view;
  const now = Math.floor(Date.now() / 1000);
  return away === "break"
    ? awayView({ breakUntil: now + 10 * DAY_SECS, selfExclusionUntil: 0 }, now)
    : awayView({ breakUntil: 0, selfExclusionUntil: now + 6 * MONTH_SECS }, now);
}
