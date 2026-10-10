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

export const LiveSeasonSignedOut: Story = { parameters: { screen: { leaderboard: "live" }, auth: "signed-out" } };

/** The season before has ended and its prizes are still being paid. */
export const PrizesBeingPaid: Story = { parameters: { screen: { leaderboard: "settling" } } };

/** A new season with no points yet. */
export const NoPointsYet: Story = { parameters: { screen: { leaderboard: "empty" } } };

/** The pool is not switched on yet: "The pool opens with the next upgrade". */
export const OpensWithNextUpgrade: Story = { parameters: { screen: { leaderboard: "upgrade" } } };

export const Loading: Story = { parameters: { screen: { leaderboard: "loading" } } };

export const LoadFailed: Story = { parameters: { screen: { leaderboard: "error" } } };
