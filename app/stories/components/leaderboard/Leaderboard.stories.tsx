import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Leaderboard } from "@/components/leaderboard/Leaderboard";
import { withScreen } from "../../screens/support/screen";

const meta = {
  title: "Components/leaderboard/Leaderboard",
  component: Leaderboard,
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/leaderboard" } }, screen: { leaderboard: "live" } },
} satisfies Meta<typeof Leaderboard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A season in progress: the Pool band, the podium, the rows (top 50 of 61, 15 a page under the podium; you are third) and last week's winners. */
export const Live: Story = {};
export const YouOnPageTwo: Story = { parameters: { screen: { leaderboard: "deep" } } };
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const PrizesBeingPaid: Story = { parameters: { screen: { leaderboard: "settling" } } };
export const NoPointsYet: Story = { parameters: { screen: { leaderboard: "empty" } } };
export const OpensWithNextUpgrade: Story = { parameters: { screen: { leaderboard: "upgrade" } } };
export const Loading: Story = { parameters: { screen: { leaderboard: "loading" } } };
export const LoadFailed: Story = { parameters: { screen: { leaderboard: "error" } } };
