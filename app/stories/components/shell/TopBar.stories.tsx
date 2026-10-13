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

/** Search on the Lobby, the Season plate (Leaderboard Pool + your rank and points, 3rd here), the Gemas balance, and the Account menu. */
export const SignedIn: Story = {};
/** A phone: menu, the Pool, your Gemas, you. */
export const Phone: Story = { globals: { viewport: { value: "phone360", isRotated: false } } };
/** A phone, big figures: the Pool shortens (12.7K), everything still fits. */
export const PhoneBigFigures: Story = {
  globals: { viewport: { value: "phone360", isRotated: false } },
  parameters: { screen: { pool: { gemas: 12_480 } } },
};
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const SigningIn: Story = { parameters: { auth: "loading" } };
export const BalanceLoading: Story = { parameters: { data: { snapshot: null } } };
export const OffTheLobby: Story = { parameters: { nextjs: { navigation: { pathname: "/wallet" } } } };
/** 23rd: the plate counts the points to the prizes. */
export const ChasingThePrizes: Story = { parameters: { screen: { leaderboard: "deep" } } };
/** No wins this Season yet. */
export const NoSeasonPoints: Story = { parameters: { screen: { leaderboard: "empty" } } };
/** A Match fee lands in the Pool every 4 s: the lid lifts, Gemas jump out, the figure counts up. */
export const PoolGrows: Story = { parameters: { screen: { pool: { gemas: 12_480, growMs: 4000 } } } };
/** Before the first read, or with the Leaderboard off: no chest. */
export const NoPool: Story = { parameters: { screen: { pool: { gemas: null } } } };

/** A small Pool (under 1,000 Gemas) stays quiet: the Season and when it ends, no figure. */
export const SmallPool: Story = { parameters: { screen: { pool: { gemas: 420 } } } };
/** Right at the threshold the figure shows. */
export const PoolAtThreshold: Story = { parameters: { screen: { pool: { gemas: 1_000 } } } };
