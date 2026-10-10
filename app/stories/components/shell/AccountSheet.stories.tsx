import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AccountSheet } from "@/components/shell/AccountSheet";

const meta = {
  title: "Components/shell/AccountSheet",
  component: AccountSheet,
  parameters: { auth: "signed-in" },
  args: { open: true, onClose: () => {}, onSignedOut: () => {} },
  argTypes: { onClose: { control: false }, onSignedOut: { control: false } },
} satisfies Meta<typeof AccountSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Addresses and the linked wallets. The demo Account has one Solana wallet linked. */
export const Open: Story = {};
export const Closed: Story = { args: { open: false } };
