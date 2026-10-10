import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Help from "@/app/(app)/help/page";

const meta = {
  title: "Screens/Help",
  component: Help,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/help" } } },
} satisfies Meta<typeof Help>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
