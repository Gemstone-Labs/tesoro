import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { GemasPanel } from "@/components/account/GemasPanel";
import { demoPlayerAccount, match } from "@/lib/chain/fixture";
import { playedRows } from "@/lib/chain/player-account";

const rows = playedRows(demoPlayerAccount("any-player").played);
const three = playedRows([
  ...demoPlayerAccount("any-player").played,
  ...[true, false, false, true, false].map((won, i) => match("trading-duel", 1000, won, 30 + i * 50, [0, 0])),
]);

const meta = {
  title: "Components/account/GemasPanel",
  component: GemasPanel,
  args: { rows },
  argTypes: { rows: { control: false } },
  decorators: [(Story) => <div className="pa" style={{ maxWidth: 680 }}><Story /></div>],
} satisfies Meta<typeof GemasPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two games played: the game menu narrows the net, the split and the running total. */
export const TwoGames: Story = {};
/** Three games: Trading Duel is net negative, so its running total dips below zero. */
export const ThreeGames: Story = { args: { rows: three } };
/** The game menu open: each game with its net, the shown one checked. */
export const MenuOpen: Story = {
  args: { rows: three },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /^Game:/ }));
    await expect(within(canvasElement).getByRole("menu")).toBeInTheDocument();
  },
};
/** A single game: no filter. */
export const OneGame: Story = { args: { rows: rows.filter((r) => r.game === "block-puzzle") } };
/** One Match with a winner: the running total waits for a second. */
export const OneMatch: Story = { args: { rows: playedRows([match("block-puzzle", 1000, true, 5, [140, 90])]) } };
