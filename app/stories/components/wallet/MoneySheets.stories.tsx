import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RedeemSheet, ReturnSheet } from "@/app/(app)/wallet/MoneySheets";
import { NativeRedeemSheet } from "@/app/(app)/wallet/NativePositions";
import { demoSnapshot } from "@/lib/chain/fixture";
import { positions } from "@/lib/mock";

const meta = {
  title: "Components/wallet/MoneySheets",
  component: RedeemSheet,
  args: { open: true, onClose: () => {} },
  argTypes: { onClose: { control: false } },
} satisfies Meta<typeof RedeemSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Redeem on the demo Account's Gemas: each one redeems for its Source asset, as far as that Source has accrued. */
export const Redeem: Story = {};

export const RedeemNothing: Story = {
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), holdings: [] }) } },
};

export const RedeemOnChain: Story = {
  render: (args) => <NativeRedeemSheet {...args} />,
};

export const ReturnUnspent: Story = {
  render: () => <ReturnSheet position={positions[0]} onClose={() => {}} />,
};
