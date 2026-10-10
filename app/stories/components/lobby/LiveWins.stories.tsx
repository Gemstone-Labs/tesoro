import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LiveWins } from "@/components/lobby/LiveWins";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/LiveWins",
  component: LiveWins,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof LiveWins>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A slow strip of recent wins. Pauses on hover and focus. */
export const Default: Story = {};

/** With no finished Matches it renders nothing. */
export const NoWins: Story = { parameters: { data: { settled: [] } } };
