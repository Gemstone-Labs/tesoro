import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar } from "@/components/account/Player";
import { DEMO_ME } from "../../support/data";

const meta = {
  title: "Components/account/AccountLink",
  component: AccountLink,
  args: { account: DEMO_ME, newTab: false, decorative: false },
  argTypes: { account: { control: "text" }, children: { control: false } },
} satisfies Meta<typeof AccountLink>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Shows the Player's name; the link goes to their Account page. */
export const Name: Story = {};
export const NewTab: Story = { args: { newTab: true } };
export const AroundAvatar: Story = {
  args: { decorative: true, children: <PlayerAvatar account={DEMO_ME} size={48} /> },
};
