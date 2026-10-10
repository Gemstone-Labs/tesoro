import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BackingSplit } from "@/components/match/BackingSplit";
import { backed, match } from "@/lib/chain/fixture";
import type { ChainMatch } from "@/lib/chain/read";

const BACKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const base = (win: boolean) => match("block-puzzle", 1000, win, 2, [151, 42]);

const meta = {
  title: "Components/match/BackingSplit",
  component: BackingSplit,
  args: { m: backed(base(true), BACKER, 4000) },
  argTypes: { m: { control: "object" } },
  decorators: [(Story) => <div className="cut cut-card" style={{ maxWidth: 480, padding: 20 }}><Story /></div>],
} satisfies Meta<typeof BackingSplit>;
export default meta;
type Story = StoryObj<typeof meta>;

const refunded = (m: ChainMatch): ChainMatch => ({ ...m, status: "refunded", session: null, winner: null });

/** As the backed Player, after a win. */
export const PlayerWon: Story = {};
export const PlayerLost: Story = { args: { m: backed(base(false), BACKER, 4000) } };
export const BackerWon: Story = { args: { m: backed(base(true), BACKER, 4000, true) } };
export const BackerLost: Story = { args: { m: backed(base(false), BACKER, 4000, true) } };
export const BiggerShare: Story = { args: { m: backed(base(true), BACKER, 7000) } };
export const Refunded: Story = { args: { m: refunded(backed(base(true), BACKER, 4000)) } };
export const RefundedForBacker: Story = { args: { m: refunded(backed(base(true), BACKER, 4000, true)) } };
