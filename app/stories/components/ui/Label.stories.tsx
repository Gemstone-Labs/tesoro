import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Label } from "@/components/ui";

const meta = {
  title: "Components/ui/Label",
  component: Label,
  args: { children: "Pending by Lock" },
} satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
