import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Ticker } from "@/components/lobby/Ticker";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/Ticker",
  component: Ticker,
  decorators: lobbyDecorators,
} satisfies Meta<typeof Ticker>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One line, changing every few seconds. */
export const Default: Story = {};
export const NoMatchesYet: Story = { parameters: { data: { settled: [] } } };
