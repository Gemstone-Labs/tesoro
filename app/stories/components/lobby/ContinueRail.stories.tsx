import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ContinueRail } from "@/components/lobby/ContinueRail";
import { chainMatch } from "../../screens/support/matches";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/ContinueRail",
  component: ContinueRail,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof ContinueRail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One card per open Match. A Match with an opponent found comes first, with a lit edge and Resume. */
export const Default: Story = {
  args: {
    matches: [chainMatch("block-puzzle", "open"), chainMatch("holdem", "active", { entry: 2500 }), chainMatch("trading-duel", "open", { challenge: true, entry: 500 })],
  },
};

/** A single Match still waiting for an opponent. */
export const Waiting: Story = { args: { matches: [chainMatch("block-puzzle", "open")] } };
