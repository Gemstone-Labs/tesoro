import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AccountSkeleton } from "@/components/account/AccountSkeleton";

const meta = {
  title: "Components/account/AccountSkeleton",
  component: AccountSkeleton,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof AccountSkeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
