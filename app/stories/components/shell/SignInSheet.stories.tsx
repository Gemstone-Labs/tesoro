import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { SignInSheet } from "@/components/shell/SignInSheet";
import { Button } from "@/components/ui";

const meta = {
  title: "Components/shell/SignInSheet",
  component: SignInSheet,
  parameters: { auth: "signed-out" },
  args: { open: true, onClose: fn(), onSignedIn: fn(), onWallet: fn() },
  argTypes: { open: { control: false }, onClose: { control: false }, onSignedIn: { control: false }, onWallet: { control: false } },
  // Close and a finished sign-in shut the sheet; the button opens it again. Calls show in Actions.
  render: function Render(args) {
    const [open, setOpen] = useState(args.open);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Sign in</Button>
        <SignInSheet
          {...args}
          open={open}
          onClose={() => { args.onClose(); setOpen(false); }}
          onSignedIn={() => { args.onSignedIn(); setOpen(false); }}
        />
      </>
    );
  },
} satisfies Meta<typeof SignInSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Email is faked offline: any address gets a code, any 6-digit code signs in, 000000 shows the error. */
export const Open: Story = {};
/** `reason` says what the Player was doing when asked to sign in (the app passes e.g. "make an Offer"). */
export const WithReason: Story = { args: { reason: "make an Offer" } };
