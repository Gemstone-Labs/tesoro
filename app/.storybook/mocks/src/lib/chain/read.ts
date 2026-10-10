// Storybook: everything in read.ts is real except `fetchMatch`, which answers with the Match the story sets (`parameters.spectated`).
import { spectated } from "../../../../../stories/components/support/spectated";
import type { ChainMatch } from "../../../../../src/lib/chain/read";

export * from "../../../../../src/lib/chain/read";

export async function fetchMatch(): Promise<ChainMatch | null> {
  const m = spectated();
  if (m === undefined) return new Promise(() => {});
  return m;
}
