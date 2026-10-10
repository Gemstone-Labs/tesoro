import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SidebarBody } from "@/components/shell/Sidebar";

const meta = {
  title: "Components/shell/Sidebar",
  component: SidebarBody,
  parameters: { layout: "fullscreen", nextjs: { navigation: { pathname: "/lobby" } } },
  argTypes: { onNavigate: { control: false } },
  decorators: [
    (Story) => (
      <aside className="sidebar" style={{ display: "block", position: "relative", width: 250, minHeight: 640 }}>
        <Story />
      </aside>
    ),
  ],
} satisfies Meta<typeof SidebarBody>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The current page is lit. Change the story's path in the toolbar's URL to see another one lit. */
export const OnLobby: Story = {};
export const OnWallet: Story = { parameters: { nextjs: { navigation: { pathname: "/wallet" } } } };
export const OnHelp: Story = { parameters: { nextjs: { navigation: { pathname: "/help" } } } };
