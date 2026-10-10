import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ChainChip } from "@/components/ui";

const meta = {
  title: "Components/ui/ChainChip",
  component: ChainChip,
  args: { chain: "SOL" },
  argTypes: { chain: { control: "inline-radio", options: ["SOL", "ETH", "HYPE"] } },
} satisfies Meta<typeof ChainChip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sol: Story = {};
export const Eth: Story = { args: { chain: "ETH" } };
export const Hype: Story = { args: { chain: "HYPE" } };
