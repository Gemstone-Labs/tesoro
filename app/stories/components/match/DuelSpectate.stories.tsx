import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DuelSpectate } from "@/components/match/DuelSpectate";
import { match } from "@/lib/chain/fixture";
import type { ChainMatch } from "@/lib/chain/read";
import { duelSettled } from "../../screens/support/matches";
import { withScreen } from "../../screens/support/screen";

const duel = (status: ChainMatch["status"]): ChainMatch => ({ ...match("trading-duel", 1000, true, 3, [0, 0]), status, winner: null });

const meta = {
  title: "Components/match/DuelSpectate",
  component: DuelSpectate,
  args: { m: duel("settled") },
  argTypes: { m: { control: false } },
  decorators: [withScreen, (Story) => <div className="mr" style={{ maxWidth: 900 }}><Story /></div>],
} satisfies Meta<typeof DuelSpectate>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A finished Duel shows both Players' trades. A live Duel reads the rollup, so it has no story. */
export const Finished: Story = { parameters: { screen: { duel: duelSettled(true) } } };
export const FinishedLost: Story = { parameters: { screen: { duel: duelSettled(false) } } };
export const TradesNotLoaded: Story = {};
export const NotStarted: Story = { args: { m: duel("open") } };
