import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { TopBar } from "@/components/shell/TopBar";

const meta = {
  title: "Components/shell/TopBar",
  component: TopBar,
  parameters: { layout: "fullscreen", auth: "signed-in", nextjs: { navigation: { pathname: "/lobby" } } },
  args: { onMenu: () => {} },
  argTypes: { onMenu: { control: false } },
} satisfies Meta<typeof TopBar>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Search on the Lobby, the Gemas balance, and the Account menu. */
export const SignedIn: Story = {};
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const SigningIn: Story = { parameters: { auth: "loading" } };
export const BalanceLoading: Story = { parameters: { data: { snapshot: null } } };
export const OffTheLobby: Story = { parameters: { nextjs: { navigation: { pathname: "/wallet" } } } };
