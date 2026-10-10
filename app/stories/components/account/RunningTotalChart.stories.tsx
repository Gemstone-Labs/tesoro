import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RunningTotalChart } from "@/components/account/RunningTotalChart";
import { demoPlayerAccount } from "@/lib/chain/fixture";
import { playedRows, runningTotal } from "@/lib/chain/player-account";
import { DEMO_ME } from "../../support/data";

const series = (n?: number) => runningTotal(playedRows(demoPlayerAccount("any-player").played)).slice(0, n);

const meta = {
  title: "Components/account/RunningTotalChart",
  component: RunningTotalChart,
  args: { series: series() },
  argTypes: { series: { control: false } },
  decorators: [(Story) => <div className="pa" style={{ maxWidth: 760 }}><div className="cut cut-card pa-panel"><Story /></div></div>],
} satisfies Meta<typeof RunningTotalChart>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A long history. Move the pointer (or use the arrow keys) to read any Match. */
export const Long: Story = {};
export const FewMatches: Story = { args: { series: series(3) } };
export const OneMatch: Story = { args: { series: series(1) } };
export const Own: Story = { args: { series: runningTotal(playedRows(demoPlayerAccount(DEMO_ME).played)) } };
