import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GameTabs, HistoryPages } from "@/components/match/MatchHistory";

const meta = {
  title: "Components/match/MatchHistory",
  component: HistoryPages,
  args: { base: "/matches", game: null, page: 2, pages: 5, total: 94 },
  argTypes: { game: { control: "select", options: [null, "block-puzzle", "holdem", "trading-duel"] } },
} satisfies Meta<typeof HistoryPages>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Newer / Older under a history. Both ends are disabled on a single page. */
export const MiddlePage: Story = {};
export const FirstPage: Story = { args: { page: 1 } };
export const LastPage: Story = { args: { page: 5 } };
export const OnePage: Story = { args: { pages: 1, total: 8 } };

/** The game filter above a history. */
export const Tabs: Story = {
  args: { game: "holdem" },
  render: (args) => <GameTabs base={args.base} game={args.game} />,
};
export const TabsAll: Story = { args: { game: null }, render: (args) => <GameTabs base={args.base} game={args.game} /> };
