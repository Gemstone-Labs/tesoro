import type { Decorator } from "@storybook/nextjs-vite";
import type { ChainMatch } from "@/lib/chain/read";

/** The Match `fetchMatch` returns in the current story (`undefined` = never answers, `null` = no such Match). */
let current: ChainMatch | null | undefined;
export const spectated = () => current;

/** Reads `parameters.spectated` before each story renders. Add it to a story file's `decorators`. */
export const withSpectated: Decorator = (Story, ctx) => {
  current = ctx.parameters.spectated as ChainMatch | null | undefined;
  return Story();
};
