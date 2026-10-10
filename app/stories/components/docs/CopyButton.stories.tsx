import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CopyButton } from "@/components/docs/CopyButton";

const meta = {
  title: "Components/docs/CopyButton",
  component: CopyButton,
  args: { value: "pnpm install", label: "Copy" },
  parameters: { themed: true },
} satisfies Meta<typeof CopyButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
