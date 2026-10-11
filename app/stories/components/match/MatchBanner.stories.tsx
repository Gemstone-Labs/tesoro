import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { MatchBanner } from "@/components/match/MatchBanner";
import { backed, match } from "@/lib/chain/fixture";
import { historyRow, type HistoryRow } from "@/lib/chain/history";
import type { ChainMatch } from "@/lib/chain/read";

const PLAYER = "6Nw6KJv8QZ2xYhrfK9tQmGbq9uTq1Yq5h3m7V8aJp4Cn";
const BACKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const row = (m: ChainMatch) => historyRow(m) as HistoryRow;
const NOW = Date.now();

const meta = {
  title: "Components/match/MatchBanner",
  component: MatchBanner,
  args: { r: row(match("block-puzzle", 1000, true, 4, [171, 55])), player: PLAYER, now: NOW },
  argTypes: { r: { control: "object" }, now: { control: false } },
  decorators: [(Story) => <div className="mb-list" style={{ maxWidth: 980 }}><Story /></div>],
} satisfies Meta<typeof MatchBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Won: Story = {};
export const Lost: Story = { args: { r: row(match("holdem", 2500, false, 90, [0, 0])) } };
export const Draw: Story = {
  args: {
    r: row((() => {
      const m = match("block-puzzle", 1000, true, 600, [118, 118]);
      return { ...m, session: m.session && { ...m.session, result: "draw" as const } };
    })()),
  },
};
export const Refunded: Story = { args: { r: row({ ...match("holdem", 1000, false, 720, [0, 0]), status: "refunded", winner: null }) } };
export const BackedWon: Story = { args: { r: row(backed(match("block-puzzle", 1000, true, 35, [150, 88]), BACKER)), backing: "Backed by 9WzD…AWWM · Backer +540" } };
export const BackedLost: Story = { args: { r: row(backed(match("block-puzzle", 1000, false, 900, [96, 140]), BACKER)), backing: "Backer 9WzD…AWWM bore the loss · −1,000" } };
export const TradingDuel: Story = { args: { r: row(match("trading-duel", 1000, true, 12, [0, 0])) } };
