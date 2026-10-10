import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Thumb } from "@/components/ui";

const meta = {
  title: "Components/ui/Thumb",
  component: Thumb,
  args: { children: "D" },
  argTypes: { variant: { control: "inline-radio", options: [undefined, "poker"] } },
} satisfies Meta<typeof Thumb>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Letter: Story = {};
export const Poker: Story = { args: { variant: "poker", children: "A♠K" } };
