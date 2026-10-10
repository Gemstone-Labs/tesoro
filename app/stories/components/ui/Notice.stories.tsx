import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Notice } from "@/components/ui";

const meta = {
  title: "Components/ui/Notice",
  component: Notice,
  args: { title: "Match", body: "Loading the Match…" },
} satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A body ending in an ellipsis shows a spinner. */
export const Loading: Story = {};
export const NotFound: Story = { args: { title: "Match not found", body: "That Match does not exist or has been removed." } };
