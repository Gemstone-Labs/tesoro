import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NavList } from "@/components/docs/NavList";

const meta = {
  title: "Components/docs/NavList",
  component: NavList,
  argTypes: { onNavigate: { control: false } },
  parameters: { themed: true, nextjs: { navigation: { pathname: "/docs/gemas" } } },
  decorators: [(Story) => <div className="docs" style={{ minHeight: 0, maxWidth: 280 }}><Story /></div>],
} satisfies Meta<typeof NavList>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The contents. The current page is lit. */
export const Default: Story = {};
export const OnOverview: Story = { parameters: { nextjs: { navigation: { pathname: "/docs" } } } };
export const Light: Story = { parameters: { theme: "light" } };
