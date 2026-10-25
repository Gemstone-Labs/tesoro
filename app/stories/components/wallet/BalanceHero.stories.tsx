import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BalanceHero } from "@/components/money/BalanceHero";
import { Button } from "@/components/ui";
import { CARD } from "@/components/money/card-copy";

const meta = {
  title: "Wallet/BalanceHero",
  component: BalanceHero,
  args: {
    label: "Gemas",
    labelInfo: "Test mode · simulated yield, 1 month = 10 min. 1 Gema = $0.01.",
    figure: "1,200",
    usdOf: 1200,
    rows: [
      { label: CARD.now, figure: "200", usdOf: 200, emerald: true, info: CARD.nowInfo(true), action: <Button variant="money">{CARD.redeem}</Button> },
      { label: "Pending", figure: "1,000", usdOf: 1000, info: `${CARD.ownInfo} ${CARD.wonInfo(75)}`, action: <Button>{CARD.instant}</Button>, note: CARD.instantNote("≈ $1.50", false) },
    ],
  },
} satisfies Meta<typeof BalanceHero>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Identical card above both the Simple and Pro bodies. */
export const Shared: Story = {};
export const Loading: Story = {
  args: { figure: "—", usdOf: undefined, busy: true, rows: [
    { label: CARD.now, figure: "—", action: <Button variant="money" disabled>{CARD.redeem}</Button> },
    { label: "Pending", figure: "—", action: <Button disabled>{CARD.instant}</Button> },
  ] },
};
