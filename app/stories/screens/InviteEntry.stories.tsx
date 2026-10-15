import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { InviteEntryView } from "@/components/account/InviteEntry";

const meta = {
  title: "Screens/Invite entry",
  component: InviteEntryView,
  parameters: { layout: "fullscreen", shell: "app" },
  args: { code: "", onCode: () => {}, onSubmit: () => {} },
} satisfies Meta<typeof InviteEntryView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Typed: Story = { args: { code: "7K2M-9QX4-TD8B-R3NV" } };
export const Working: Story = { args: { code: "7K2M-9QX4-TD8B-R3NV", busy: "Creating your Account…" } };
export const WrongCode: Story = { args: { code: "7K2M-9QX4-TD8B-R3NV", error: "That Invite code isn’t valid." } };
export const UsedCode: Story = { args: { code: "7K2M-9QX4-TD8B-R3NV", error: "That Invite code has already been used." } };
