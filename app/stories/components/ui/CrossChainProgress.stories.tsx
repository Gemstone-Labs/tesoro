import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Card, CrossChainProgress } from "@/components/ui";

const meta = {
  title: "Components/ui/CrossChainProgress",
  component: CrossChainProgress,
  args: { stage: 1, chain: "ETH", txHash: "0x7be1…a09c", failed: false },
  argTypes: {
    stage: { control: { type: "range", min: 0, max: 3 } },
    chain: { control: "inline-radio", options: ["SOL", "ETH", "HYPE"] },
  },
  decorators: [(Story) => <div style={{ maxWidth: 460 }}><Card large><Story /></Card></div>],
} satisfies Meta<typeof CrossChainProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Success shows only at the last step. Pending never shows success early. */
export const Started: Story = { args: { stage: 0 } };
export const Verifying: Story = {};
export const Crediting: Story = { args: { stage: 2 } };
export const Done: Story = { args: { stage: 3 } };
export const Failed: Story = { args: { stage: 1, failed: true, chain: "HYPE" } };
