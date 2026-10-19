import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Card, PendingBySource } from "@/components/ui";

const meta = {
  title: "Components/ui/PendingBySource",
  component: PendingBySource,
  args: {
    items: [
      { key: "a", chain: "HYPE", owner: "Bob's Lock", pending: 2200, accruedShare: 0.12 },
      { key: "b", chain: "ETH", owner: "Carol's Lock", pending: 1197, accruedShare: 0.71 },
      { key: "c", chain: "SOL", owner: "Your Lock", pending: 4316, accruedShare: 0 },
    ],
  },
  decorators: [(Story) => <div style={{ maxWidth: 460 }}><Card large><Story /></Card></div>],
} satisfies Meta<typeof PendingBySource>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSources: Story = {};
export const Nothing: Story = { args: { items: [] } };
