// Storybook: a Backed Queue entry follows the Match flow story step by step; everything else is real (and offline).
import * as real from "../../../../../src/lib/chain/backing";
import { flowFrame } from "../../../../../stories/screens/support/flow-store";
import { flowEntry } from "./match-flow";

export * from "../../../../../src/lib/chain/backing";

export const enterQueueBacked = (...a: Parameters<typeof real.enterQueueBacked>) => (flowFrame() ? flowEntry(a[5]) : real.enterQueueBacked(...a));
