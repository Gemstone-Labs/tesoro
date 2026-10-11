import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BalanceSplit } from "@/components/ui";

const meta = {
  title: "Components/ui/BalanceSplit",
  component: BalanceSplit,
  args: { redeemable: 1599, pending: 8461, redeemableSources: 4 },
  decorators: [(Story) => <div style={{ maxWidth: 520 }}><Story /></div>],
} satisfies Meta<typeof BalanceSplit>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Redeemable now and pending on one bar to scale, each figure under its own end. */
export const Default: Story = {};
export const OneSource: Story = { args: { redeemableSources: 1 } };
export const NothingRedeemable: Story = { args: { redeemable: 0, redeemableSources: undefined } };
export const NothingPending: Story = { args: { redeemable: 10060, pending: 0, redeemableSources: 6 } };
export const Phone: Story = { decorators: [(Story) => <div style={{ maxWidth: 340 }}><Story /></div>] };
