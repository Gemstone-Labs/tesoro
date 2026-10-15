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

/** Past its settle time and not settled: the card says Delayed and when the Match refunds at the latest. */
export const Delayed: Story = {
  args: {
    matches: [
      chainMatch("block-puzzle", "active", { entry: 1000 }),
      { ...chainMatch("trading-duel", "active", { entry: 500 }), deadline: Math.floor(Date.now() / 1000) + 3600 - 900 },
    ].map((m, i) =>
      i === 0 && m.session ? { ...m, deadline: Math.floor(Date.now() / 1000) + 1500, session: { ...m.session, deadline: Math.floor(Date.now() / 1000) - 600, openerDeadline: Math.floor(Date.now() / 1000) - 600 } } : m,
    ),
  },
};
export const Delayed1440: Story = { ...Delayed, globals: { viewport: { value: "desktop1440", isRotated: false } } };
export const Delayed390: Story = { ...Delayed, globals: { viewport: { value: "phone390", isRotated: false } } };
