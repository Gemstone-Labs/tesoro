import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { TopBar } from "@/components/shell/TopBar";
import { withScreen } from "../../screens/support/screen";

const meta = {
  title: "Components/shell/TopBar",
  component: TopBar,
  decorators: [withScreen],
  parameters: { layout: "fullscreen", auth: "signed-in", nextjs: { navigation: { pathname: "/lobby" } } },
  args: { onMenu: () => {} },
  argTypes: { onMenu: { control: false } },
} satisfies Meta<typeof TopBar>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Search on the Lobby, the Leaderboard Pool chest, the Gemas balance, and the Account menu. */
export const SignedIn: Story = {};
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const SigningIn: Story = { parameters: { auth: "loading" } };
export const BalanceLoading: Story = { parameters: { data: { snapshot: null } } };
export const OffTheLobby: Story = { parameters: { nextjs: { navigation: { pathname: "/wallet" } } } };
/** A Match fee lands in the Pool every 4 s: the lid lifts, Gemas jump out, the figure counts up. */
export const PoolGrows: Story = { parameters: { screen: { pool: { gemas: 12_480, growMs: 4000 } } } };
/** Before the first read, or with the Leaderboard off: no chest. */
export const NoPool: Story = { parameters: { screen: { pool: { gemas: null } } } };
