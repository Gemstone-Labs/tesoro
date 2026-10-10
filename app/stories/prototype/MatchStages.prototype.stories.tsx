// PROTOTYPE ONLY: every state around play for one Game on a single page; the pink bar (or ←/→)
// switches all of them between the variants in MatchStage.prototype.tsx. Delete with it.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { STAGE_VARIANTS, StageArena, StageCharacter, StagePoster, type StageKind, type StageModel } from "@/components/match/MatchStage.prototype";
import type { GameId } from "@/lib/mock";

const ME = "B6AeTq3rNbHkzG4mJdP7wq8vXsY2cLf5eRuKa9hFRPm";
const OPP = "D1gtWm5xQ8pLr2nVb7kZs4yHc6jTe3uAo9fGi1d5uHP";
const noop = () => undefined;

function model(game: GameId, kind: StageKind, o: Partial<StageModel> = {}): StageModel {
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
    primary: kind === "ready" ? { label: "Start · 90 s", onClick: noop } : null,
    actions: waiting ? [{ label: "Cancel and refund", onClick: noop }] : kind === "awaiting" ? [{ label: "Check now", onClick: noop }] : [],
    ...o,
  };
}

const STATES: Record<GameId, [string, StageModel][]> = {
  "block-puzzle": [
    ["Run in, waiting to be paired (Queue)", model("block-puzzle", "waiting-run")],
    ["Run in, Challenge link", model("block-puzzle", "waiting-run", { challengeLink: "https://tesoro-fawn.vercel.app/play/challenge/3583289476503" })],
    ["Getting the run ready", model("block-puzzle", "setup")],
    ["Ready", model("block-puzzle", "ready")],
    ["Ready, backed", model("block-puzzle", "ready", { backedShareBps: 5000 })],
    ["Saving the run", model("block-puzzle", "saving-run")],
    ["Waiting for the opponent's score", model("block-puzzle", "awaiting")],
    ["Waiting, time ran out", model("block-puzzle", "awaiting", { actions: [{ label: "Check now", onClick: noop }, { label: "Time’s up: refund both entries", onClick: noop }] })],
    ["Backer watching", model("block-puzzle", "backer-watch", { score: null })],
  ],
  holdem: [
    ["Waiting for an opponent", model("holdem", "waiting")],
    ["Waiting, Challenge link", model("holdem", "waiting", { challengeLink: "https://tesoro-fawn.vercel.app/play/challenge/3583289476505" })],
    ["Opponent found, setting up", model("holdem", "setup")],
    ["Match over, saving", model("holdem", "closing")],
  ],
  "trading-duel": [
    ["Waiting for an opponent", model("trading-duel", "waiting")],
    ["Waiting, Challenge link", model("trading-duel", "waiting", { challengeLink: "https://tesoro-fawn.vercel.app/play/challenge/3583289476507" })],
    ["Opponent found, setting up", model("trading-duel", "setup")],
    ["Match over, saving", model("trading-duel", "closing")],
  ],
};

function Gallery({ game }: { game: GameId }) {
  const v = usePrototypeVariant(STAGE_VARIANTS.map((x) => x.key));
  const Stage = v === "B" ? StagePoster : v === "C" ? StageCharacter : StageArena;
  return (
    <div style={{ display: "grid", gap: 56, padding: "32px 24px 120px" }}>
      {v === "now" && <p style={{ color: "var(--fg-2)" }}>“Current” lives in Screens/Match stories; this gallery shows A when on “now”.</p>}
      {STATES[game].map(([label, m]) => (
        <div key={label} style={{ display: "grid", gap: 12 }}>
          <div style={{ font: "700 12px/1 var(--f-mono)", color: "#ff3df0", letterSpacing: ".08em", textTransform: "uppercase", borderTop: "1px dashed rgba(255,61,240,.4)", paddingTop: 12 }}>
            {label}
          </div>
          <Stage m={m} />
        </div>
      ))}
      <PrototypeSwitcher variants={STAGE_VARIANTS.filter((x) => x.key !== "now")} />
    </div>
  );
}

const meta = { title: "Prototype/Match stages", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const BlockPuzzle: Story = { render: () => <Gallery game="block-puzzle" /> };
export const Holdem: Story = { render: () => <Gallery game="holdem" /> };
export const TradingDuel: Story = { render: () => <Gallery game="trading-duel" /> };
