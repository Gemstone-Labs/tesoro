import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DebtChart, PositionTile, emptyRows, linearSeries } from "@/app/(app)/wallet/PositionTile";
import { Button } from "@/components/ui";

const NOW = Date.now();
const series = linearSeries(0.55, NOW, NOW + 10 * 60_000);

const meta = {
  title: "Components/wallet/PositionTile",
  component: PositionTile,
  args: {
    chain: "SOL",
    status: "active",
    label: "SOL Position",
    chartTitle: "Debt (SOL)",
    rows: { principal: "40 SOL", debt: "0.55 SOL", apy: "7.0%", unlock: "Today, 12:20" },
    series,
    children: <><Button variant="money" size="sm">Redeem</Button><Button size="sm">Return Gemas</Button></>,
  },
  argTypes: {
    chain: { control: "inline-radio", options: ["SOL", "ETH", "HYPE"] },
    status: { control: "inline-radio", options: ["active", "unlocked", "none", "soon"] },
    rows: { control: "object" },
    series: { control: false },
    children: { control: false },
    fmt: { control: false },
  },
  decorators: [(Story) => <div style={{ maxWidth: 420 }}><Story /></div>],
} satisfies Meta<typeof PositionTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
export const Unlocked: Story = { args: { status: "unlocked", rows: { principal: "40 SOL", debt: "0 SOL", apy: "7.0%", unlock: "Unlocked" }, series: linearSeries(0, NOW, null) } };
export const Eth: Story = { args: { chain: "ETH", chartTitle: "Debt (ETH)", label: "ETH Position", rows: { principal: "2 ETH", debt: "0.04 ETH", apy: "3.0%", unlock: "Today, 12:40" } } };
export const Hype: Story = { args: { chain: "HYPE", status: "soon", chartTitle: "Debt (HYPE)", label: "HYPE Position", rows: emptyRows, series: null, children: null } };
export const NoPosition: Story = { args: { status: "none", rows: emptyRows, series: null, children: <Button variant="money" size="sm">Open a Position</Button> } };

/** The projected Debt chart alone: with a series, and the empty axis. */
export const Chart: Story = {
  render: () => (
    <div className="stack">
      <DebtChart title="Debt (SOL)" series={series} fmt={(n) => n.toFixed(2)} />
      <DebtChart title="Debt (SOL)" series={null} fmt={(n) => n.toFixed(2)} />
    </div>
  ),
};
