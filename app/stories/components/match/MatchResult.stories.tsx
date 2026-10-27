import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult, type MatchResultProps } from "@/components/match/MatchResult";
import { backed, match } from "@/lib/chain/fixture";
import { backerDelta, matchDelta, matchFee } from "@/lib/chain/ledger";
import { chainMatchFromPage, type ChainMatch } from "@/lib/chain/read";
import real from "@/lib/chain/match-pages/block-burst-devnet-2026-10-27.json";
import type { MatchPage } from "@/server/history/reads";
import { PublicKey } from "@solana/web3.js";
import type { GameId } from "@/lib/mock";

const BACKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** One Match result from a fixture Match, the way the real result page builds it. */
function props(game: GameId, win: boolean, extra: { backing?: "player" | "backer"; refunded?: boolean; draw?: boolean } = {}): MatchResultProps {
  let m: ChainMatch = match(game, 1000, win, 2, [151, 42]);
  if (extra.draw && m.session) m = { ...m, session: { ...m.session, result: "draw", scores: [88, 88] } };
  if (extra.refunded) m = { ...m, status: "refunded", session: null, winner: null };
  if (extra.backing) m = backed(m, BACKER, 4000, extra.backing === "backer");
  const outcome = extra.refunded ? "refunded" : extra.draw ? "draw" : win ? "won" : "lost";
  const delta = extra.backing === "backer" ? backerDelta({ ...m, backerSeat: 0, shareBps: 4000 }) : matchDelta(m);
  const scores: [string, string] | null = extra.refunded ? null : game === "holdem" ? [win ? "Won" : "Lost", win ? "Lost" : "Won"] : [String(m.session?.scores[0]), String(m.session?.scores[1])];
  return {
    game,
    outcome,
    delta,
    entry: m.entry,
    fee: Math.floor(m.entry * 2 * 0.05),
    role: extra.backing === "backer" ? "backer" : "player",
    backed: !!m.backing,
    scores,
    playAgainHref: "/play/queue",
    opponent: m.opponent,
    momentKey: `story-${game}-${outcome}-${extra.backing ?? "own"}`,
    split: m.backing ? <BackingSplit m={m} /> : undefined,
  };
}

const meta = {
  title: "Components/match/MatchResult",
  component: MatchResult,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/play/match/1" } } },
  args: props("block-puzzle", true),
  argTypes: {
    game: { control: "inline-radio", options: ["block-puzzle", "holdem", "trading-duel"] },
    outcome: { control: "inline-radio", options: ["won", "lost", "draw", "refunded"] },
    role: { control: "inline-radio", options: ["player", "backer"] },
    split: { control: false },
    children: { control: false },
  },
} satisfies Meta<typeof MatchResult>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Change the outcome, amounts or scores in Controls. The win overlay shows once per tab; reload to see it again. */
export const Won: Story = {};
export const Lost: Story = { args: props("block-puzzle", false) };
export const Draw: Story = { args: props("block-puzzle", true, { draw: true }) };
export const Refunded: Story = { args: props("block-puzzle", true, { refunded: true }) };
export const BackedPlayerWon: Story = { args: props("block-puzzle", true, { backing: "player" }) };
export const BackedPlayerLost: Story = { args: props("block-puzzle", false, { backing: "player" }) };
export const BackerWon: Story = { args: props("block-puzzle", true, { backing: "backer" }) };
export const BackerLost: Story = { args: props("block-puzzle", false, { backing: "backer" }) };
export const BackedRefunded: Story = { args: props("block-puzzle", true, { backing: "player", refunded: true }) };
export const HoldemWon: Story = { args: props("holdem", true) };
export const HoldemLost: Story = { args: props("holdem", false) };
export const TradingDuelWon: Story = { args: { ...props("trading-duel", true), scores: ["800 points", "500 points"] } };

export const NoOpponentKnown: Story = { args: { ...props("block-puzzle", true), opponent: null } };

/** Settled amounts of real devnet Block Burst Matches (entry 500), read through the history page the app reads: the winner gained 440 and the Fee was 60. */
const fromPage = (page: MatchPage, who: string, over: Partial<MatchResultProps> = {}): MatchResultProps => {
  const m = chainMatchFromPage(page, new PublicKey(who))!;
  const outcome = m.status === "refunded" ? "refunded" : page.winner === null ? "draw" : page.winner === who ? "won" : "lost";
  return { game: "block-puzzle", outcome, delta: matchDelta(m), entry: m.entry, fee: matchFee(m), role: "player", backed: false, scores: null, playAgainHref: "/play/queue", opponent: m.opponent, points: m.settled?.points, momentKey: `story-real-${outcome}`, matchId: m.id, ...over };
};
const REAL_WIN = real["won-lost"] as unknown as MatchPage;
const WINNER = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const LOSER = "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU";
export const RealWon: Story = { args: fromPage(REAL_WIN, WINNER) };
export const RealLost: Story = { args: fromPage(REAL_WIN, LOSER) };
export const RealRefunded: Story = { args: fromPage(real.refunded as unknown as MatchPage, WINNER) };
/** No real draw exists on devnet yet: this one is the won page with the draw's settled amounts (nothing moves). */
export const RealDraw: Story = { args: fromPage({ ...REAL_WIN, winner: null, loser: null, winnerSide: null, kind: 2, points: null, fees: { studio: 0, platform: 0, leaderboard: 0 }, parties: REAL_WIN.parties.map((p) => ({ ...p, delta: 0, result: "draw" })) } as MatchPage, WINNER) };
