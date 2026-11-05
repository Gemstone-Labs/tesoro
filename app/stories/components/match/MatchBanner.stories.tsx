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
  args: { r: row(match("block-puzzle", 1000, true, 4, [171, 55])), account: PLAYER, me: PLAYER, now: NOW },
  argTypes: { r: { control: "object" }, now: { control: false } },
  decorators: [(Story) => <div className="mb-list" style={{ maxWidth: 980 }}><Story /></div>],
} satisfies Meta<typeof MatchBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Won: Story = {};
export const Lost: Story = { args: { r: row(match("holdem", 1000, false, 90, [0, 0])) } };
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
/** A Match this Account backed: the Player it backed takes the left seat. */
export const AsBacker: Story = { args: { r: row(backed(match("block-puzzle", 1000, true, 300, [164, 97]), BACKER, 3000, true)) } };

// ---- Railcar rides in the same history layout ----------------------------------------------------------------------

const ride = (o: Partial<HistoryRow>): HistoryRow => ({ id: `${PLAYER}-9`, game: "railcar", entry: 500, role: "player", result: "won", delta: 313, backing: null, scores: null, opp: null, at: NOW - 40 * 60_000, asset: null, ride: { seated: 5, kind: "place", place: 1, jumpMs: 99_000 }, ...o });
/** Last off of 5: entry back plus 60% of what the rest forfeited after fees. */
export const RailcarLastOff: Story = { args: { r: ride({}) } };
/** Jumped early at 0:25: 70% of the entry back. */
export const RailcarJumpedEarly: Story = { args: { r: ride({ result: "lost", delta: -150, ride: { seated: 5, kind: "early", jumpMs: 25_000 } }) } };
/** Aboard at Impact: the entry is lost. */
export const RailcarAboard: Story = { args: { r: ride({ result: "lost", delta: -500, ride: { seated: 42, kind: "aboard" } }) } };
/** Nobody jumped: every entry back. */
export const RailcarRefunded: Story = { args: { r: ride({ result: "refunded", delta: 0, ride: { seated: 5, kind: "refund" } }) } };
/** A ride this Account backed: Ben placed second at a 40% share; the Backer's entry came home plus 60% of the winnings. */
export const RailcarAsBacker: Story = { args: { r: ride({ role: "backer", delta: 78, backing: { other: PLAYER, shareBps: 4_000 }, ride: { seated: 5, kind: "place", place: 2, jumpMs: 97_000 } }), account: BACKER, me: BACKER } };

/** The Matches list with rides among head-to-head Matches, as the history page lists them. */
const mixed = [
  ride({}),
  row(match("block-puzzle", 1000, true, 4, [171, 55])),
  ride({ id: `${PLAYER}-8`, result: "lost", delta: -150, at: NOW - 3 * 3_600_000, ride: { seated: 37, kind: "early", jumpMs: 25_000 } }),
  row(match("holdem", 1000, false, 90, [0, 0])),
  ride({ id: `${PLAYER}-7`, result: "lost", delta: -500, at: NOW - 26 * 3_600_000, ride: { seated: 100, kind: "aboard" } }),
];
export const HistoryWithRides: Story = {
  render: () => (
    <div className="mb-list" role="list">
      {mixed.map((r) => (
        <div key={r.id} role="listitem">
          <MatchBanner r={r} account={PLAYER} me={PLAYER} now={NOW} />
        </div>
      ))}
    </div>
  ),
};
export const HistoryWithRides390: Story = { ...HistoryWithRides, globals: { viewport: { value: "phone390", isRotated: false } } };
export const HistoryWithRides1440: Story = { ...HistoryWithRides, globals: { viewport: { value: "desktop1440", isRotated: false } } };
