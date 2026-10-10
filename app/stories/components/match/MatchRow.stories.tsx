import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { MatchRow } from "@/components/match/MatchRow";
import { backed, match } from "@/lib/chain/fixture";
import { historyRow, type HistoryRow } from "@/lib/chain/history";
import type { ChainMatch } from "@/lib/chain/read";

const BACKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const row = (m: ChainMatch) => historyRow(m) as HistoryRow;
const NOW = Date.now();

const meta = {
  title: "Components/match/MatchRow",
  component: MatchRow,
  args: { r: row(match("block-puzzle", 1000, true, 4, [171, 55])), now: NOW, showGame: false, link: "match" },
  argTypes: { link: { control: "inline-radio", options: ["match", "opponent"] }, r: { control: "object" }, now: { control: false } },
  decorators: [(Story) => <div className="mh-list" style={{ maxWidth: 860 }}><Story /></div>],
} satisfies Meta<typeof MatchRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Won: Story = {};
export const Lost: Story = { args: { r: row(match("holdem", 2500, false, 90, [0, 0])), showGame: true } };
export const Draw: Story = {
  args: {
    r: row((() => {
      const m = match("block-puzzle", 1000, true, 600, [118, 118]);
      return { ...m, session: m.session && { ...m.session, result: "draw" as const } };
    })()),
  },
};
export const Refunded: Story = { args: { r: row({ ...match("holdem", 1000, false, 720, [0, 0]), status: "refunded", winner: null }) } };
export const BackedPlayerWon: Story = { args: { r: row(backed(match("block-puzzle", 1000, true, 35, [150, 88]), BACKER)) } };
export const BackedPlayerLost: Story = { args: { r: row(backed(match("block-puzzle", 1000, false, 900, [96, 140]), BACKER)) } };
export const AsBacker: Story = { args: { r: row(backed(match("block-puzzle", 2500, true, 300, [164, 97]), BACKER, 3000, true)) } };
export const TradingDuel: Story = { args: { r: row(match("trading-duel", 1000, true, 12, [0, 0])), showGame: true } };
export const OnAnotherAccount: Story = { args: { link: "opponent" } };
export const CustomBackingLine: Story = { args: { r: row(backed(match("block-puzzle", 1000, true, 35, [150, 88]), BACKER)), backing: "Backed by Ana" } };
