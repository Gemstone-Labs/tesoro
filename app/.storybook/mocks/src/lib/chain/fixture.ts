// Storybook: demo mode is always on, and a story's `parameters.data` replaces any of the demo reads.
import * as real from "../../../../../src/lib/chain/fixture";
import { storyData } from "../../../../../stories/support/data";

export const { match, backed, demoSnapshot, DEMO_NEW_ACCOUNT, DEMO_NO_ACCOUNT } = real;

export const demoMode = () => true;
export const demoBoard: typeof real.demoBoard = () => storyData().data.board ?? real.demoBoard();
export const demoSettled: typeof real.demoSettled = () => storyData().data.settled ?? real.demoSettled();
export const demoPlayerAccount: typeof real.demoPlayerAccount = (address) =>
  storyData().data.playerAccount?.(address) ?? real.demoPlayerAccount(address);
