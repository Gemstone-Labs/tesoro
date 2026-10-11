import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PageNotFound } from "@/components/shell/PageNotFound";

/** src/app/not-found.tsx wraps this in the real Account provider, which Storybook swaps for its demo Accounts. */
const meta = {
  title: "Screens/Page not found",
  component: PageNotFound,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/nowhere" } } },
} satisfies Meta<typeof PageNotFound>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
