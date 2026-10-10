import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LeaderboardTeaser } from "@/components/lobby/LeaderboardTeaser";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/LeaderboardTeaser",
  component: LeaderboardTeaser,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app", screen: { leaderboard: "live" } },
} satisfies Meta<typeof LeaderboardTeaser>;
export default meta;
type Story = StoryObj<typeof meta>;

/** This week's prize pool and the top three. */
export const Live: Story = {};
export const NoPointsYet: Story = { parameters: { screen: { leaderboard: "empty" } } };
export const Loading: Story = { parameters: { screen: { leaderboard: "loading" } } };
/** If the read fails the teaser hides itself: the Lobby does not depend on it. */
export const LoadFailed: Story = { parameters: { screen: { leaderboard: "error" } } };
