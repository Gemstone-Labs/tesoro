import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DuelSpectate } from "@/components/match/DuelSpectate";
import { match } from "@/lib/chain/fixture";
import type { ChainMatch } from "@/lib/chain/read";

const duel = (status: ChainMatch["status"]): ChainMatch => ({ ...match("trading-duel", 1000, true, 3, [0, 0]), status, winner: null });

const meta = {
  title: "Components/match/DuelSpectate",
  component: DuelSpectate,
  args: { m: duel("settled") },
  argTypes: { m: { control: false } },
  decorators: [(Story) => <div className="mr" style={{ maxWidth: 640 }}><Story /></div>],
} satisfies Meta<typeof DuelSpectate>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A finished Duel reads both Books; Storybook has no network, so it stays on "Loading the trades". A live Duel reads the rollup, so it has no story. */
export const Finished: Story = {};
export const NotStarted: Story = { args: { m: duel("open") } };
