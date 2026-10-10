import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BalanceCard } from "@/components/ui";

const meta = {
  title: "Components/ui/BalanceCard",
  component: BalanceCard,
  args: { total: 10060, title: "Your Gemas" },
  decorators: [(Story) => <div style={{ maxWidth: 420 }}><Story /></div>],
} satisfies Meta<typeof BalanceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Zero: Story = { args: { total: 0 } };
export const Large: Story = { args: { total: 1250000 } };
