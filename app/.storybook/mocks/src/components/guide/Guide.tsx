// Storybook: the Guide's tips show only with the toolbar "Guide" switch on (`parameters.guide: "on"` per story).
import * as real from "../../../../../src/components/guide/Guide";
import { storyData } from "../../../../../stories/support/data";

export const { GuideProvider, useGuideTip, useGuideHidden } = real;
export type { GuideTip, PoseName } from "../../../../../src/components/guide/Guide";

export function GuideOverlay() {
  return storyData().guide ? <real.GuideOverlay /> : null;
}
