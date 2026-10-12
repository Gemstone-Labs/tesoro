import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui";
import { MatchStage, StageAction, type StageKind } from "@/components/match/MatchStage";
import type { GameId } from "@/lib/mock";

const ME = "B6AeTq3rNbHkzG4mJdP7wq8vXsY2cLf5eRuKa9hFRPm";
const OPP = "D1gtWm5xQ8pLr2nVb7kZs4yHc6jTe3uAo9fGi1d5uHP";
const LINK = "https://www.playtesoro.com/play/challenge/3583289476503";
const noop = () => undefined;

type Props = ComponentProps<typeof MatchStage>;

/** Fixture props for one state, the way the Match views fill them. */
function stage(game: GameId, kind: StageKind, o: Partial<Props> = {}): Props {
  const waiting = kind === "waiting" || kind === "waiting-run";
  return {
    game,
    kind,
    entry: 1000,
    pot: 1880,
    me: ME,
    opponent: waiting ? null : OPP,
    asset: game === "trading-duel" ? "SOL" : undefined,
    score: kind === "waiting-run" || kind === "awaiting" || kind === "saving-run" ? 171 : null,
    step: kind === "setup" ? "Creating your session" : kind === "saving-run" ? "Saving your last moves" : kind === "closing" ? "Paying out the Pot" : undefined,
    deadline: waiting ? Math.floor(Date.now() / 1000) + 47 * 60 + 12 : undefined,
    start: kind === "ready" && (
      <Button variant="money" size="lg" block onClick={noop}>
        Start · 90 s
      </Button>
    ),
    actions: waiting ? <StageAction onClick={noop}>Cancel and refund</StageAction> : kind === "awaiting" ? <StageAction onClick={noop}>Check now</StageAction> : null,
    ...o,
  };
}

const meta = {
  title: "Components/match/MatchStage",
  component: MatchStage,
  args: stage("block-puzzle", "waiting-run"),
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof MatchStage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Block Puzzle: your run is in, nobody has joined yet. Gemas flow into the Pot, the empty seat scans. */
export const RunInWaiting: Story = {};
export const ChallengeLink: Story = { args: stage("block-puzzle", "waiting-run", { challengeLink: LINK }) };
/** Pieces are dealt out to both seats. */
export const GettingReady: Story = { args: stage("block-puzzle", "setup") };
export const Ready: Story = { args: stage("block-puzzle", "ready") };
export const ReadyBacked: Story = { args: stage("block-puzzle", "ready", { backedShareBps: 5000 }) };
export const SavingRun: Story = { args: stage("block-puzzle", "saving-run") };
export const AwaitingOpponent: Story = { args: stage("block-puzzle", "awaiting") };
export const TimeRanOut: Story = {
  args: stage("block-puzzle", "awaiting", {
    actions: (
      <>
        <StageAction onClick={noop}>Check now</StageAction>
        <StageAction onClick={noop}>Time’s up: refund both entries</StageAction>
      </>
    ),
  }),
};
export const BackerWatching: Story = { args: stage("block-puzzle", "backer-watch", { score: null }) };
export const HoldemWaiting: Story = { args: stage("holdem", "waiting") };
/** Card backs are dealt. */
export const HoldemSetup: Story = { args: stage("holdem", "setup") };
/** Gemas rise out of the Pot. */
export const HoldemClosing: Story = { args: stage("holdem", "closing") };
export const DuelWaiting: Story = { args: stage("trading-duel", "waiting", { challengeLink: LINK }) };
/** Chips are dealt. */
export const DuelSetup: Story = { args: stage("trading-duel", "setup") };
export const WithError: Story = { args: stage("block-puzzle", "awaiting", { error: "Your opponent is still playing." }) };
