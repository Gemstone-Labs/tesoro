import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GameTabs, HistoryPages, ResultFilter } from "@/components/match/MatchHistory";
import { PLAYED, RESULTS } from "@/lib/chain/history";

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

const COUNTS = { won: 12, lost: 7, draw: 1, "no-show": 3, refunded: 9 };
/** Which results show: played Matches by default, Refunded off until picked. */
export const Results: Story = { render: (args) => <ResultFilter base={args.base} game={args.game} results={PLAYED} counts={COUNTS} /> };
export const ResultsAllOn: Story = { render: (args) => <ResultFilter base={args.base} game={args.game} results={RESULTS} counts={COUNTS} /> };
/** No draws yet: the Draw toggle is left out. */
export const ResultsNoDraws: Story = { render: (args) => <ResultFilter base={args.base} game={args.game} results={PLAYED} counts={{ ...COUNTS, draw: 0 }} /> };
