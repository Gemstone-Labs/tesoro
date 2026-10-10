import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Landing from "@/app/(marketing)/page";

const meta = {
  title: "Screens/Landing",
  component: Landing,
  parameters: { layout: "fullscreen", shell: "marketing", nextjs: { navigation: { pathname: "/" } } },
} satisfies Meta<typeof Landing>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The home page, dark. The toolbar Motion switch turns the scroll and hero motion down. */
export const Dark: Story = {};

export const Light: Story = { parameters: { theme: "light" } };
