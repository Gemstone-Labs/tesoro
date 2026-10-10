import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/PlayNowRail",
  component: PlayNowRail,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof PlayNowRail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Live Games as large tiles, announced ones as a quiet strip. */
export const Default: Story = {};
export const WaitingPlayers: Story = { parameters: { screen: { queueDepth: { "block-puzzle": 3, holdem: 1, "trading-duel": 0 } } } };
