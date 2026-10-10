import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { demoSnapshot as demo } from "@/lib/chain/fixture";
import { EnterMatch } from "@/components/match/EnterMatch";
import { GamePage } from "@/app/(app)/play/[game]/GamePage";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";

const route = (pathname: string, query: Record<string, string> = {}) => ({ nextjs: { navigation: { pathname, query } } });
import { withScreen } from "./support/screen";
import { withSigner } from "./support/signer";

const meta = {
  title: "Screens/Play",
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const Lobby = ({ children }: { children: ReactNode }) => <div className="lobby">{children}</div>;

/** `/play`: every Game as a tile. */
export const Picker: Story = { render: () => <Lobby><PlayNowRail /></Lobby>, parameters: route("/play") };

/** `/play/<game>`: entry picker, your recent Matches, top scores and how to play. */
export const BlockPuzzle: Story = { render: () => <GamePage game="block-puzzle" />, parameters: route("/play/block-puzzle") };
export const Holdem: Story = { render: () => <GamePage game="holdem" />, parameters: route("/play/holdem") };
export const TradingDuel: Story = { render: () => <GamePage game="trading-duel" />, parameters: route("/play/trading-duel") };

export const BlockPuzzleSignedOut: Story = { ...BlockPuzzle, parameters: { ...route("/play/block-puzzle"), auth: "signed-out" } };

/** `/play/practice`: nothing staked. Hold'em and Trading Duel play a local bot. */
export const PracticeBlockPuzzle: Story = { render: () => <BlockPuzzleGame />, parameters: route("/play/practice") };
export const PracticeHoldem: Story = { render: () => <HoldemPractice />, parameters: route("/play/practice", { game: "holdem" }) };
export const PracticeTradingDuel: Story = {
  render: () => (
    <Suspense>
      <TradingDuelPractice />
    </Suspense>
  ),
  parameters: route("/play/practice", { game: "trading-duel" }),
};

/** `/play/queue`: the page that enters the Queue. With no wallet to sign, it stays on the first step. */
export const Queue: Story = { render: () => <EnterMatch kind="queue" entry={1000} game="block-puzzle" />, parameters: route("/play/queue", { entry: "1000" }) };
/** With a wallet that can sign but no network, entering fails and says so. */
export const QueueFailed: Story = { ...Queue, decorators: [withSigner] };
export const QueueSignedOut: Story = { ...Queue, parameters: { ...route("/play/queue", { entry: "1000" }), auth: "signed-out" } };
export const QueueNotEnoughGemas: Story = {
  render: () => <EnterMatch kind="queue" entry={2500} game="holdem" />,
  parameters: {
    ...route("/play/queue", { entry: "2500", game: "holdem" }),
    data: { snapshot: (a: string) => ({ ...demo(a), holdings: [], ownTotal: 0n, wonTotal: 0n }) },
  },
};

/** `/play/challenge`: a new Challenge link; `/play/challenge/<id>`: opening someone's link joins it. */
export const ChallengeCreate: Story = { render: () => <EnterMatch kind="challenge-new" entry={1000} game="block-puzzle" />, parameters: route("/play/challenge", { entry: "1000" }) };
export const ChallengeCreateFailed: Story = { ...ChallengeCreate, decorators: [withSigner] };
export const ChallengeJoin: Story = { render: () => <EnterMatch kind="challenge-join" id="3581887481018" />, parameters: route("/play/challenge/3581887481018") };

