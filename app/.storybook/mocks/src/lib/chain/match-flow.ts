// Storybook: the Match's chain steps answer from the story (`parameters.screen.run`), or follow a Match flow story step by step; nothing is sent.
import * as real from "../../../../../src/lib/chain/match-flow";
import type { RunSubmitter } from "../../../../../src/lib/chain/run-submitter";
import { screenData } from "../../../../../stories/screens/support/screen";
import { flowFrame, untilFrame } from "../../../../../stories/screens/support/flow-store";

export * from "../../../../../src/lib/chain/match-flow";

/** In a flow story: reports each step's progress line until the step where the entry lands. */
export async function flowEntry(onStep?: (s: string) => void): Promise<real.Entered> {
  await untilFrame((f) => {
    if (f.status) onStep?.(f.status);
    return !!f.entered;
  });
  const f = flowFrame()!;
  return { id: f.match!.id, via: f.entered! };
}

export const enterQueue = async (...a: Parameters<typeof real.enterQueue>): Promise<real.Entered> => {
  if (flowFrame()) return flowEntry(a[4]);
  if (screenData().entered === "existing") return { id: "11111111111111111111111111111111-3581887481018", via: "existing" };
  return real.enterQueue(...a);
};
export const createChallenge = async (...a: Parameters<typeof real.createChallenge>) => (flowFrame() ? (await flowEntry(a[5])).id : real.createChallenge(...a));
export const joinChallenge = async (...a: Parameters<typeof real.joinChallenge>) => (flowFrame() ? void (await flowEntry()) : real.joinChallenge(...a));

export const ensureJoined = async () => {};
export const probeRun = async () => screenData().run?.stage ?? "ready";
export const prepareRun = (_signer: unknown, _id: bigint, _seat: unknown, onStep: (s: string) => void) => {
  if (!flowFrame()) {
    onStep("Creating your session");
    return new Promise<void>(() => {});
  }
  return untilFrame((f) => {
    const run = f.screen?.run;
    if (run?.step) onStep(run.step);
    return run?.stage !== "needs-prep";
  });
};
export const runSubmitter = () => ({ push() {}, finish: async () => {}, error: null }) as unknown as RunSubmitter;
export const trySettle = async () => {
  const error = screenData().run?.settleError;
  return error ? { outcome: "failed" as const, error } : { outcome: "waiting-opponent" as const };
};
export const canClaimTimeout = async () => !!screenData().run?.timeout;
export const claimTimeout = async () => "demo-claim";
export const refundMatch = async () => "demo-refund";
