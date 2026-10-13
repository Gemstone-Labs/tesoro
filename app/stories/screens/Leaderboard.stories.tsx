import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Leaderboard from "@/app/(app)/leaderboard/page";
import { withScreen } from "./support/screen";

const meta = {
  title: "Screens/Leaderboard",
  component: Leaderboard,
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/leaderboard" } } },
} satisfies Meta<typeof Leaderboard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A season in progress: the pool, the table (you are third), the prize scale and last week's winners. */
export const LiveSeason: Story = { parameters: { screen: { leaderboard: "live" } } };

/** You are 23rd: page 1 offers "You’re 23rd" to jump to your page. */
export const YouOnPageTwo: Story = { parameters: { screen: { leaderboard: "deep" } } };

/** A phone: the chest spans the card over the Pool figure. */
export const LiveSeasonPhone: Story = {
  globals: { viewport: { value: "phone360", isRotated: false } },
  parameters: { screen: { leaderboard: "live" } },
};
export const LiveSeasonSignedOut: Story = { parameters: { screen: { leaderboard: "live" }, auth: "signed-out" } };

/** The season before has ended and its prizes are still being paid. */
export const PrizesBeingPaid: Story = { parameters: { screen: { leaderboard: "settling" } } };

/** Under 1,000 Gemas in the Pool the hero shows the Season and its countdown, no figure. */
export const SmallPool: Story = { parameters: { screen: { leaderboard: "live", pool: { gemas: 420 } } } };

/** A new season with no points yet. */
export const NoPointsYet: Story = { parameters: { screen: { leaderboard: "empty" } } };

/** The pool is not switched on yet: "The pool opens with the next upgrade". */
export const OpensWithNextUpgrade: Story = { parameters: { screen: { leaderboard: "upgrade" } } };

export const Loading: Story = { parameters: { screen: { leaderboard: "loading" } } };

export const LoadFailed: Story = { parameters: { screen: { leaderboard: "error" } } };
