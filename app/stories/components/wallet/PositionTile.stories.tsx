import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PositionTile, linearSeries } from "@/app/(app)/wallet/PositionTile";
import { Button } from "@/components/ui";

const NOW = Date.now();
const IN_8 = NOW + 8 * 60_000;

const meta = {
  title: "Components/wallet/PositionTile",
  component: PositionTile,
  args: {
    chain: "SOL",
    label: "SOL Lock",
    state: "repaying",
    principal: "40.000 SOL",
    debt: "1,377 Gemas",
    debtAsset: "0.550 SOL",
    apy: "7.0%",
    unlockAt: IN_8,
    now: NOW,
    defaultOpen: true,
    series: linearSeries(1377, NOW, IN_8),
    notes: (
      <>
        <p className="note">Earned 0.04512 SOL (simulated).</p>
        <p className="note">Unlock returns your SOL once it is paid back. Only this Lock&apos;s own yield pays it back.</p>
      </>
    ),
    children: (
      <>
        <Button size="sm" block>Refresh yield</Button>
        <div className="wl-actions-row"><Button variant="money" size="sm">Redeem</Button><Button size="sm" disabled>Unlock</Button></div>
      </>
    ),
  },
  argTypes: {
    chain: { control: "inline-radio", options: ["SOL", "ETH", "HYPE"] },
    state: { control: "inline-radio", options: ["repaying", "paid", "idle", "unlocked"] },
    series: { control: false },
    notes: { control: false },
    children: { control: false },
  },
  decorators: [(Story) => <div style={{ maxWidth: 540 }}><Story /></div>],
} satisfies Meta<typeof PositionTile>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Debt open: when the Principal comes back, and the Debt burning down to zero. */
export const Repaying: Story = {};

/** How every card starts on the Wallet: head, countdown and a one-line Debt; a tap opens the rest. */
export const Folded: Story = { args: { defaultOpen: false } };

/** Cross-chain, longer figures. */
export const Eth: Story = {
  args: { chain: "ETH", label: "ETH Lock", principal: "2.0000 ETH", debt: "4,928 Gemas", debtAsset: "0.0155 ETH", apy: "3.0%", unlockAt: NOW + 12 * 60_000, series: linearSeries(4928, NOW, NOW + 12 * 60_000) },
};

/** Repaying, but no yield has landed yet to estimate from. */
export const WaitingForYield: Story = { args: { unlockAt: null, series: null } };

export const Paid: Story = {
  args: {
    chain: "HYPE", label: "HYPE Lock", state: "paid", principal: "1.5000 HYPE", debt: "0", debtAsset: undefined, apy: "5.0%", unlockAt: null, series: null, notes: undefined,
    children: <div className="wl-actions-row"><Button variant="money" size="sm">Redeem</Button><Button size="sm">Unlock</Button></div>,
  },
};

export const NoAdvance: Story = {
  args: { state: "idle", principal: "12 SOL", debt: null, debtAsset: undefined, unlockAt: null, series: null, notes: undefined, children: <Button variant="money" size="sm" block>Take an Advance</Button> },
};

export const Unlocked: Story = {
  args: {
    state: "unlocked", debt: "0", debtAsset: undefined, unlockAt: null, series: null, notes: <p className="note">Earned 0.31210 SOL (simulated).</p>,
    children: <Button size="sm" block>Collect leftover yield · 0.0021 test SOL</Button>,
  },
};
