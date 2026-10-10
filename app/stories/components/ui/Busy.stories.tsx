import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Busy } from "@/components/ui";

const meta = {
  title: "Components/ui/Busy",
  component: Busy,
  args: { children: "Creating your session" },
} satisfies Meta<typeof Busy>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A spinner and one plain line for a step the Player waits through. */
export const Default: Story = {};
