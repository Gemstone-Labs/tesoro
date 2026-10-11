import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RunningTotalChart } from "@/components/account/RunningTotalChart";
import { demoPlayerAccount, match } from "@/lib/chain/fixture";
import { playedRows, runningTotal } from "@/lib/chain/player-account";
import { DEMO_ME } from "../../support/data";

const series = (n?: number) => runningTotal(playedRows(demoPlayerAccount("any-player").played)).slice(0, n);
/** Down early, back above zero late: both fills, the low and the peak. */
const dip = runningTotal(
  playedRows([false, false, true, false, false, true, true, true, false, true, true, true].map((won, i) => match("block-puzzle", 1000, won, 600 - i * 40, [120, 80]))),
);

const meta = {
  title: "Components/account/RunningTotalChart",
  component: RunningTotalChart,
  args: { series: series(), showGame: true },
  argTypes: { series: { control: false } },
  decorators: [(Story) => <div className="pa" style={{ maxWidth: 760 }}><div className="cut cut-card pa-panel"><Story /></div></div>],
} satisfies Meta<typeof RunningTotalChart>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A long history. Move the pointer (or use the arrow keys) to read any Match. */
export const Long: Story = {};
export const FewMatches: Story = { args: { series: series(3) } };
export const BelowZero: Story = { args: { series: dip } };
/** One game picked in the panel's filter: the caption drops the game name. */
export const OneGame: Story = { args: { series: dip, showGame: false } };
export const Own: Story = { args: { series: runningTotal(playedRows(demoPlayerAccount(DEMO_ME).played)) } };
