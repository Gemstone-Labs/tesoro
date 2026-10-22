import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { HoldemMatchView } from "@/games/holdem/HoldemMatchView";
import { TradingDuelMatchView } from "@/games/trading-duel/TradingDuelMatchView";
import { MatchView } from "@/components/match/MatchView";
import type { ChainMatch } from "@/lib/chain/read";
import { withSpectated } from "../components/support/spectated";
import { chainMatch, duelLive, duelSettled, holdemClock, holdemLive, holdemOver, lateMatch, type MatchState } from "./support/matches";
import { withScreen, type ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";

const meta = {
  title: "Screens/Match",
  decorators: [withSigner, withScreen, withSpectated],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const signedOut = (s: Story): Story => ({ ...s, parameters: { ...s.parameters, auth: "signed-out" } });

const route = (m: ChainMatch) => ({ nextjs: { navigation: { pathname: `/play/match/${m.id}` } } });

/** Block Burst: the Match view reads the Match and the Player's run. */
function blockPuzzle(state: MatchState, run: ScreenData["run"], o: Parameters<typeof chainMatch>[2] = {}, extra: Partial<Story> = {}): Story {
  const m = chainMatch("block-puzzle", state, o);
  return { render: () => <MatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { run } }, ...extra };
}

/** A Block Burst Match past its settle time, with your run in. */
function blockPuzzleLate(refundOpen: boolean): Story {
  const m = lateMatch(chainMatch("block-puzzle", "active"), refundOpen);
  return { render: () => <MatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { run: { stage: "finished" } } } };
}

function holdem(state: MatchState, view: ScreenData["holdem"], o: Parameters<typeof chainMatch>[2] = {}, late?: boolean): Story {
  const m = late === undefined ? chainMatch("holdem", state, o) : lateMatch(chainMatch("holdem", state, o), late);
  return { render: () => <HoldemMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { holdem: { match: m, seat: m.seat, ...view } } } };
}

function duel(state: MatchState, view: ScreenData["duel"], o: Parameters<typeof chainMatch>[2] = {}, late?: boolean): Story {
  const m = late === undefined ? chainMatch("trading-duel", state, o) : lateMatch(chainMatch("trading-duel", state, o), late);
  return { render: () => <TradingDuelMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { duel: { match: m, seat: m.seat, ...view } } } };
}

/* Block Burst */

/** Your run is in and nobody has joined yet. */
export const BlockPuzzleWaitingForOpponent = blockPuzzle("open", { stage: "finished" });
export const BlockPuzzleWaitingChallenge = blockPuzzle("open", { stage: "finished" }, { challenge: true });
/** Opened, not played yet: the Start card. */
export const BlockPuzzleReady = blockPuzzle("active", { stage: "ready" });
export const BlockPuzzleGettingReady = blockPuzzle("active", { stage: "needs-prep" });
/** Press Start run to play; the pieces here are made up and nothing is sent. */
export const BlockPuzzleLive = blockPuzzle("active", { stage: "ready" }, {}, {
  play: async ({ canvasElement }) => {
    const start = await waitFor(() => within(canvasElement).getByRole("button", { name: /Start run/ }), { timeout: 10_000 });
    await userEvent.click(start);
  },
});
export const BlockPuzzleWaitingForScore = blockPuzzle("active", { stage: "finished" });
export const BlockPuzzleTimedOut = blockPuzzle("active", { stage: "finished", timeout: true });
export const BlockPuzzleWon = blockPuzzle("won", { stage: "committed" });
export const BlockPuzzleLost = blockPuzzle("lost", { stage: "committed" });
export const BlockPuzzleDraw = blockPuzzle("draw", { stage: "committed" });
export const BlockPuzzleRefunded = blockPuzzle("refunded", { stage: "committed" });
export const BlockPuzzleWonBacked = blockPuzzle("won", { stage: "committed" }, { backing: "player" });
export const BlockPuzzleBackerWatching = blockPuzzle("active", { stage: "finished" }, { backing: "backer" });
export const BlockPuzzleBackerWon = blockPuzzle("won", { stage: "committed" }, { backing: "backer" });
/** The Player is backed and nobody has joined: Cancel hands the Gemas back to the Backer. */
export const BlockPuzzleBackedWaiting = blockPuzzle("open", { stage: "finished" }, { backing: "player" });
/** A backed Player lost: the Backer's share of the entry is gone too, shown under the result. */
export const BlockPuzzleLostBacked = blockPuzzle("lost", { stage: "committed" }, { backing: "player" });
/** The Backer's Player lost the Match. */
export const BlockPuzzleBackerLost = blockPuzzle("lost", { stage: "committed" }, { backing: "backer" });
/** Past the time the Match should have settled, refund deadline still ahead: "Delayed, refunds by …". */
export const BlockPuzzleDelayed = blockPuzzleLate(false);
/** Past the settle time and the refund deadline: "Delayed, refund is open" with a Refund Match button. */
export const BlockPuzzleDelayedRefundOpen = blockPuzzleLate(true);
/** Settling failed: the page shows the "Couldn’t finish the Match" line under the waiting card. */
export const BlockPuzzleSettleFailed = blockPuzzle("active", { stage: "finished", settleError: "Couldn’t finish the Match. Try again." });
/** Someone else's Match: read-only. */
export const BlockPuzzleSpectator = blockPuzzle("spectator", { stage: "committed" });
export const BlockPuzzleSignedOut = signedOut(blockPuzzle("spectator", { stage: "committed" }));
export const BlockPuzzleNotFound: Story = { render: () => <MatchView matchId="404" />, parameters: { spectated: null, screen: { run: { stage: "committed" } } } };

/* Hold'em */

export const HoldemWaitingForOpponent = holdem("open", { stage: "waiting" });
export const HoldemWaitingChallenge = holdem("open", { stage: "waiting" }, { challenge: true });
export const HoldemSettingUp = holdem("active", { stage: "setup", note: "Creating your session" });
/** Your turn before the flop. */
export const HoldemLivePreflop = holdem("active", holdemLive("preflop"));
export const HoldemLiveFlop = holdem("active", holdemLive("flop"));
export const HoldemLiveFacingABet = holdem("active", holdemLive("facing-bet"));
export const HoldemSavingResult = holdem("active", holdemOver());
export const HoldemWon = holdem("won", { stage: "settled" });
export const HoldemLost = holdem("lost", { stage: "settled" });
export const HoldemRefunded = holdem("refunded", { stage: "settled" });
export const HoldemWonBacked = holdem("won", { stage: "settled" }, { backing: "player" });
export const HoldemLostBacked = holdem("lost", { stage: "settled" }, { backing: "player" });
/** It is the opponent's turn and their clock still runs. */
export const HoldemOpponentsTurn = holdem("active", holdemClock("opponent"));
/** The opponent's clock ran out: a Claim timeout button appears. */
export const HoldemOpponentClockOutClaim = holdem("active", holdemClock("opponent-late"));
/** Your own clock ran out: act now or the opponent can claim a timeout. */
export const HoldemYourClockOut = holdem("active", holdemClock("mine-late"));
/** The table is over but the Match never settled and its refund deadline passed: Refund Match. */
export const HoldemDelayedRefundOpen = holdem("active", { stage: "closing", note: "Saving the result", refundable: true }, {}, true);
export const HoldemSpectator = holdem("spectator", { stage: "spectator", seat: null });

/* Trading Duel */

export const TradingDuelWaitingForOpponent = duel("open", { stage: "waiting" });
export const TradingDuelWaitingChallenge = duel("open", { stage: "waiting" }, { challenge: true });
export const TradingDuelSettingUp = duel("active", { stage: "setup", note: "Creating your session" });
export const TradingDuelHeadStart = duel("active", duelLive("headstart"));
export const TradingDuelMidGame = duel("active", duelLive("mid"));
export const TradingDuelLastColumn = duel("active", duelLive("last"));
export const TradingDuelWon = duel("won", duelSettled(true));
export const TradingDuelLost = duel("lost", duelSettled(false));
export const TradingDuelWonBacked = duel("won", duelSettled(true), { backing: "player" });
export const TradingDuelLostBacked = duel("lost", duelSettled(false), { backing: "player" });
/** The Duel never settled and its refund deadline passed: "Delayed, refund is open" with Refund Match. */
export const TradingDuelDelayedRefundOpen = duel("active", { stage: "closing", note: "Saving the result", refundable: true }, {}, true);
export const TradingDuelRefunded = duel("refunded", { stage: "settled" });
export const TradingDuelSpectator = duel("spectator", { ...duelSettled(true), stage: "spectator", seat: null });

export const HoldemSignedOut = signedOut(holdem("spectator", { stage: "spectator", seat: null }));
export const TradingDuelSignedOut = signedOut(duel("spectator", { ...duelSettled(true), stage: "spectator", seat: null }));
