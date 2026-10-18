import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { HoldemMatchView } from "@/games/holdem/HoldemMatchView";
import { TradingDuelMatchView } from "@/games/trading-duel/TradingDuelMatchView";
import { VanguardMatchView } from "@/games/vanguard/VanguardMatchView";
import { MatchView } from "@/components/match/MatchView";
import type { ChainMatch } from "@/lib/chain/read";
import { withSpectated } from "../components/support/spectated";
import { chainMatch, duelLive, duelSettled, holdemLive, holdemOver, type MatchState } from "./support/matches";
import { withScreen, type ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";
import * as vg from "./support/vanguard";

const meta = {
  title: "Screens/Match",
  decorators: [withSigner, withScreen, withSpectated],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const signedOut = (s: Story): Story => ({ ...s, parameters: { ...s.parameters, auth: "signed-out" } });

const route = (m: ChainMatch) => ({ nextjs: { navigation: { pathname: `/play/match/${m.id}` } } });

/** Block Puzzle: the Match view reads the Match and the Player's run. */
function blockPuzzle(state: MatchState, run: ScreenData["run"], o: Parameters<typeof chainMatch>[2] = {}, extra: Partial<Story> = {}): Story {
  const m = chainMatch("block-puzzle", state, o);
  return { render: () => <MatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { run } }, ...extra };
}

function holdem(state: MatchState, view: ScreenData["holdem"], o: Parameters<typeof chainMatch>[2] = {}): Story {
  const m = chainMatch("holdem", state, o);
  return { render: () => <HoldemMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { holdem: { match: m, seat: m.seat, ...view } } } };
}

function duel(state: MatchState, view: ScreenData["duel"], o: Parameters<typeof chainMatch>[2] = {}): Story {
  const m = chainMatch("trading-duel", state, o);
  return { render: () => <TradingDuelMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { duel: { match: m, seat: m.seat, ...view } } } };
}

function vanguard(state: MatchState, view: ScreenData["vanguard"], o: Parameters<typeof chainMatch>[2] = {}): Story {
  const m = chainMatch("vanguard", state, o);
  return { render: () => <VanguardMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { vanguard: { match: m, seat: m.seat, ...view } } } };
}

const phone = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone390", isRotated: false } } });

/* Block Puzzle */

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
export const TradingDuelRefunded = duel("refunded", { stage: "settled" });
export const TradingDuelSpectator = duel("spectator", { ...duelSettled(true), stage: "spectator", seat: null });

export const HoldemSignedOut = signedOut(holdem("spectator", { stage: "spectator", seat: null }));
export const TradingDuelSignedOut = signedOut(duel("spectator", { ...duelSettled(true), stage: "spectator", seat: null }));

/* Vanguard */

export const VanguardWaitingForOpponent = vanguard("open", { stage: "waiting" }, { challenge: true });
export const VanguardSettingUp = vanguard("active", { stage: "setup", note: "Drawing the armies in secret" });
/** Your turn: the opening position, your army face up at the bottom. Tap a piece, then a marked square. */
export const VanguardYourTurn = vanguard("active", vg.yourTurn());
export const VanguardYourTurnPhone = phone(vanguard("active", vg.yourTurn()));
/** You moved; their turn. A moment later they move and the piece slides in. */
export const VanguardTheirTurn = vanguard("active", vg.theirMove());
export const VanguardTheirTurnPhone = phone(vanguard("active", vg.theirMove()));
/** Contact: your General (9) next to a hidden 7. Attack it; nothing is sent in a story. */
export const VanguardAttack = vanguard("active", vg.yourAttack());
/** Their 8 hits your 4 a moment after you open this: the 8 is flashed face up as your 4 falls. */
export const VanguardFight = vanguard("active", vg.fight());
export const VanguardFightPhone = phone(vanguard("active", vg.fight()));
/** Every move is refused by the rollup a moment after you make it: the piece slides, then goes back with the reason. */
export const VanguardMoveRefused = vanguard("active", { ...vg.yourTurn(), refuse: "That piece can't go there." });
/** You play the Italian Army: the board is turned so your army is at the bottom. */
export const VanguardItalianSide = vanguard("active", vg.asItaly());
export const VanguardItalianSidePhone = phone(vanguard("active", vg.asItaly()));
/** Italian side: their General hits your 7 from the other direction, so the flip comes from the opposite side. */
export const VanguardItalianFight = vanguard("active", vg.italyFight());
/** The Dust Storm blows at the end of their turn and drifts a line of pieces one square. */
export const VanguardStorm = vanguard("active", vg.storm());
export const VanguardStormPhone = phone(vanguard("active", vg.storm()));
/** Your Truck is captured: every piece turns face up, the result is being saved. */
export const VanguardEnd = vanguard("active", vg.end());
export const VanguardEndPhone = phone(vanguard("active", vg.end()));
export const VanguardEndTimeouts = vanguard("active", vg.endTimeouts());
export const VanguardWon = vanguard("won", { stage: "settled" });
export const VanguardLost = vanguard("lost", { stage: "settled" });
export const VanguardRefunded = vanguard("refunded", { stage: "settled" });
export const VanguardSpectator = vanguard("spectator", { stage: "spectator", seat: null });
