import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BalanceCard } from "@/components/ui";

const meta = {
  title: "Components/ui/BalanceCard",
  component: BalanceCard,
  args: { total: 10060, title: "Your Gemas" },
  decorators: [(Story, ctx) => (ctx.parameters.widths ? <Story /> : <div style={{ width: 420, maxWidth: "100%" }}><Story /></div>)],
} satisfies Meta<typeof BalanceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Zero: Story = { args: { total: 0 } };
export const Large: Story = { args: { total: 1250000 } };

/** PROTOTYPE: the card at phone, sidebar and page widths. */
export const Widths: Story = {
  parameters: { widths: true },
  decorators: [(Story) => <div style={{ display: "grid", gap: 24 }}>{[340, 420, 720].map((w) => <div key={w} style={{ width: w }}><Story /></div>)}</div>],
};
