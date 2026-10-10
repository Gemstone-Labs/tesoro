// Storybook: the Block Puzzle Match's chain steps answer from the story (`parameters.screen.run`); nothing is sent.
import type { RunSubmitter } from "../../../../../src/lib/chain/run-submitter";
import { screenData } from "../../../../../stories/screens/support/screen";

export * from "../../../../../src/lib/chain/match-flow";

export const ensureJoined = async () => {};
export const probeRun = async () => screenData().run?.stage ?? "ready";
export const prepareRun = (_signer: unknown, _id: bigint, _seat: unknown, onStep: (s: string) => void) => {
  onStep("Creating your session");
  return new Promise<void>(() => {});
};
export const runSubmitter = () => ({ push() {}, finish: async () => {}, error: null }) as unknown as RunSubmitter;
export const trySettle = async () => ({ outcome: "waiting-opponent" as const });
export const canClaimTimeout = async () => !!screenData().run?.timeout;
export const claimTimeout = async () => "demo-claim";
export const refundMatch = async () => "demo-refund";
