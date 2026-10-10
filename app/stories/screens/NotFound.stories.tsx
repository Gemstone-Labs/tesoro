import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import NotFound from "@/app/not-found";

const meta = {
  title: "Screens/Page not found",
  component: NotFound,
  parameters: { layout: "fullscreen", nextjs: { navigation: { pathname: "/nowhere" } } },
} satisfies Meta<typeof NotFound>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Any address with no page. It brings its own app shell, so the story adds none. */
export const Default: Story = {};
