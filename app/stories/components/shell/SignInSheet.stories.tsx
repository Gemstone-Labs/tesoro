import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SignInSheet } from "@/components/shell/SignInSheet";

const meta = {
  title: "Components/shell/SignInSheet",
  component: SignInSheet,
  parameters: { auth: "signed-out" },
  args: { open: true, onClose: () => {}, onSignedIn: () => {}, onWallet: () => {} },
  argTypes: { onClose: { control: false }, onSignedIn: { control: false }, onWallet: { control: false } },
} satisfies Meta<typeof SignInSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
/** `reason` says why the Player was asked to sign in. */
export const WithReason: Story = { args: { reason: "Sign in to enter this Match." } };
