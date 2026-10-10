import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Receipts } from "@/components/match/Receipts";

const sig = (n: number) => `${n}`.repeat(64).slice(0, 64).replace(/./g, (c, i) => "abcdefghijkmnpqrstuvwxyz23456789"[(Number(c) + i * 7) % 32]);

const meta = {
  title: "Components/match/Receipts",
  component: Receipts,
  args: {
    items: [
      { label: "create_match", sig: sig(1) },
      { label: "open_holding", sig: sig(2) },
      { label: "delegate_match", sig: sig(3) },
      { label: "begin_run", sig: sig(4), layer: "tee" },
      { label: "close_match commit", sig: sig(5) },
      { label: "settle", sig: sig(6) },
    ],
  },
  argTypes: { items: { control: "object" } },
  decorators: [(Story) => <div style={{ maxWidth: 420 }}><Story /></div>],
} satisfies Meta<typeof Receipts>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed by default. Public steps link to the explorer; private ones only show a name. */
export const Block: Story = {};
export const OneReceipt: Story = { args: { items: [{ label: "refund", sig: sig(9) }] } };
export const Empty: Story = { args: { items: [] } };
