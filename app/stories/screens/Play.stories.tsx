import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Suspense } from "react";
import { demoSnapshot as demo } from "@/lib/chain/fixture";
import { EnterMatch } from "@/components/match/EnterMatch";
import { GamePage } from "@/app/(app)/play/[game]/GamePage";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";

const route = (pathname: string, query: Record<string, string> = {}) => ({ nextjs: { navigation: { pathname, query } } });
import { demoKey, withScreen } from "./support/screen";
import { withSigner } from "./support/signer";

const meta = {
  title: "Screens/Play",
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

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

/** A game page while you are on a Break: the notice replaces Play now and Challenge a friend; Practice stays. */
export const BlockPuzzleOnABreak: Story = { ...BlockPuzzle, parameters: { ...route("/play/block-puzzle"), screen: { away: "break" } } };

/** A game page while Self-Excluded: the Self-Exclusion notice replaces Play now. */
export const HoldemSelfExcluded: Story = { ...Holdem, parameters: { ...route("/play/holdem"), screen: { away: "self-exclusion" } } };

/** Entering the Queue while you still have an unfinished Match: it says to finish that one, with Continue. */
export const QueueUnfinishedMatch: Story = { ...Queue, decorators: [withSigner], parameters: { ...route("/play/queue", { entry: "1000" }), screen: { entered: "existing" } } };

/** Entering before the 18+ confirmation is given: the confirmation card asks first. */
export const QueueAgeConfirmation: Story = { ...Queue, decorators: [withSigner], parameters: { ...route("/play/queue", { entry: "1000" }), screen: { age: "ask" } } };

/** A Rematch: the opponent's seat shows the Player you faced and the line says same opponent, Game and entry. */
export const ChallengeRematch: Story = {
  render: () => <EnterMatch kind="challenge-new" entry={1000} game="block-puzzle" opponent={demoKey(61)} />,
  parameters: route("/play/challenge", { entry: "1000" }),
};

/** An Account that does not exist yet: the entry says we create it as part of this step. */
export const QueueFirstTime: Story = {
  ...Queue,
  parameters: { ...route("/play/queue", { entry: "1000" }), data: { snapshot: (a: string) => ({ ...demo(a), exists: false }) } },
};
