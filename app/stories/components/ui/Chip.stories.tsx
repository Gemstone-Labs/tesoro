import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CheckIcon, ChainChip, Chip, XIcon } from "@/components/ui";

const meta = {
  title: "Components/ui/Chip",
  component: Chip,
  args: { children: "Pending", tone: "warn" },
  argTypes: { tone: { control: "inline-radio", options: ["neutral", "strong", "money", "warn", "danger"] }, icon: { control: false } },
} satisfies Meta<typeof Chip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Results carry an icon and words, never colour alone. */
export const Won: Story = { args: { tone: "money", children: "Won", icon: <CheckIcon /> } };
export const Lost: Story = { args: { tone: "danger", children: "Lost", icon: <XIcon /> } };

export const AllTones: Story = {
  render: () => (
    <div className="hstack" style={{ flexWrap: "wrap" }}>
      <Chip>Neutral</Chip>
      <Chip tone="strong">Strong</Chip>
      <Chip tone="money" icon={<CheckIcon />}>Won</Chip>
      <Chip tone="danger" icon={<XIcon />}>Lost</Chip>
      <Chip tone="warn">Pending</Chip>
    </div>
  ),
};

export const Chains: Story = {
  render: () => (
    <div className="hstack">
      <ChainChip chain="SOL" />
      <ChainChip chain="ETH" />
      <ChainChip chain="HYPE" />
    </div>
  ),
};
