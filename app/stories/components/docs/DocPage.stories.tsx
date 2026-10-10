import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DocPage, H2 } from "@/components/docs/prose";

const meta = {
  title: "Components/docs/DocPage",
  component: DocPage,
  args: { href: "/docs/fees", children: <><H2 id="what">What it is</H2><p>The page body goes here.</p></> },
  argTypes: { href: { control: "text" }, children: { control: false } },
  parameters: { layout: "fullscreen", shell: "docs", nextjs: { navigation: { pathname: "/docs/fees" } } },
} satisfies Meta<typeof DocPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The page frame: group label, title and summary (from the docs navigation), body, then Previous and Next. */
export const Middle: Story = {};
export const First: Story = { args: { href: "/docs" }, parameters: { nextjs: { navigation: { pathname: "/docs" } } } };
