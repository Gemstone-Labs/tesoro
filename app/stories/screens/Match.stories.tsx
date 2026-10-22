import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HoldemMatchView } from "@/games/holdem/HoldemMatchView";
import { TradingDuelMatchView } from "@/games/trading-duel/TradingDuelMatchView";
import { VanguardMatchView } from "@/games/vanguard/VanguardMatchView";
import { MatchView } from "@/components/match/MatchView";
import type { ChainMatch } from "@/lib/chain/read";
import { withSpectated } from "../components/support/spectated";
import { chainMatch, duelLive, duelSettled, holdemClock, holdemLive, holdemOver, lateMatch, type MatchState } from "./support/matches";
import { burstView } from "./support/burst";
import { withScreen, type ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";
import * as vg from "./support/vanguard";
import * as vp from "./support/vanguard-powers";

const meta = {
  title: "Screens/Match",
  decorators: [withSigner, withScreen, withSpectated],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const signedOut = (s: Story): Story => ({ ...s, parameters: { ...s.parameters, auth: "signed-out" } });

const route = (m: ChainMatch) => ({ nextjs: { navigation: { pathname: `/play/match/${m.id}` } } });

/** Block Burst: the Match view follows the table; the story says what the driver reports. */
function blockPuzzle(state: MatchState, burst: ScreenData["burst"], o: Parameters<typeof chainMatch>[2] = {}, extra: Partial<Story> = {}): Story {
  const m = chainMatch("block-puzzle", state, o);
  return { render: () => <MatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { burst: { match: m, seat: m.seat, ...burst } } }, ...extra };
}

/** A Block Burst Match that ended before any scores existed (a check-in loss, a refund): the result has none. */
function noScores(state: MatchState, reason: number | null): Story {
  const m = { ...chainMatch("block-puzzle", state), session: null, winner: state === "won" ? ("opener" as const) : state === "lost" ? ("joiner" as const) : null };
  return { render: () => <MatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { burst: { stage: "settled", match: m, seat: m.seat, reason } } } };
}

/** A Block Burst Match at one stage of the table. */
function table(kind: Parameters<typeof burstView>[0], state: MatchState = "active", o: Parameters<typeof chainMatch>[2] = {}, extra: Partial<Story> = {}): Story {
  const m = chainMatch("block-puzzle", state, o);
  return blockPuzzle(state, burstView(kind, m), o, extra);
}

/** A Block Burst Match past its refund deadline with the table never started. */
function blockPuzzleLate(refundOpen: boolean): Story {
  const m = lateMatch(chainMatch("block-puzzle", "active"), refundOpen);
  return { render: () => <MatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { burst: { match: m, seat: m.seat, ...burstView("closing", m), refundable: refundOpen } } } };
}

function holdem(state: MatchState, view: ScreenData["holdem"], o: Parameters<typeof chainMatch>[2] = {}, late?: boolean): Story {
  const m = late === undefined ? chainMatch("holdem", state, o) : lateMatch(chainMatch("holdem", state, o), late);
  return { render: () => <HoldemMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { holdem: { match: m, seat: m.seat, ...view } } } };
}

function duel(state: MatchState, view: ScreenData["duel"], o: Parameters<typeof chainMatch>[2] = {}, late?: boolean): Story {
  const m = late === undefined ? chainMatch("trading-duel", state, o) : lateMatch(chainMatch("trading-duel", state, o), late);
  return { render: () => <TradingDuelMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { duel: { match: m, seat: m.seat, ...view } } } };
}

function vanguard(state: MatchState, view: ScreenData["vanguard"], o: Parameters<typeof chainMatch>[2] = {}): Story {
  const m = chainMatch("vanguard", state, o);
  return { render: () => <VanguardMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { vanguard: { match: m, seat: m.seat, ...view } } } };
}

const phone = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone390", isRotated: false } } });

/* Block Burst */

/** Nobody has joined yet: you sit first, and the Queue is told you are here. */
export const BlockPuzzleWaitingForOpponent = blockPuzzle("open", { stage: "waiting" });
export const BlockPuzzleWaitingChallenge = blockPuzzle("open", { stage: "waiting" }, { challenge: true });
/** Joined, but the operator has not given the Match a table: the refund time is on the page. */
export const BlockPuzzleWaitingForTable = table("table");
export const BlockPuzzleCheckIn = table("checkIn");
export const BlockPuzzleCheckedIn = table("checkedIn");
export const BlockPuzzleDealing = table("seeding");
/** The count to zero is the table's start slot minus its slot. */
export const BlockPuzzleGetReady = table("getReady");
/** Both Players play at once; the strip shows the opponent's last public score. */
export const BlockPuzzleLive = table("playing");
/** From 80 s both scores are hidden: the strip shows ?. */
export const BlockPuzzleLastTenSeconds = table("last10");
/** Your run ended before the clock: stuck, or out of moves. */
export const BlockPuzzleWaitingForClock = table("waitClock");
/** A second tab of this browser is playing this Match for you. */
export const BlockPuzzlePlayingElsewhere = table("elsewhere");
/** The rollup cannot be read: the board is still yours and the screen says so. */
export const BlockPuzzleReconnecting = table("reconnect");
export const BlockPuzzleClosing = table("closing");
/** The opponent never checked in. */
export const BlockPuzzleOpponentGone = table("opponentGone");
export const BlockPuzzleWon = blockPuzzle("won", { stage: "settled", reason: 1 });
export const BlockPuzzleLost = blockPuzzle("lost", { stage: "settled", reason: 1 });
export const BlockPuzzleDraw = blockPuzzle("draw", { stage: "settled", reason: 8 });
/** The opponent never checked in: you won. */
export const BlockPuzzleWonOpponentAbsent = noScores("won", 2);
/** You never checked in: the Match went to your opponent. */
export const BlockPuzzleLostNotCheckedIn = noScores("lost", 2);
/** Nobody checked in: both entries are back. */
export const BlockPuzzleRefundedNobodyCheckedIn = noScores("refunded", 3);
/** The rollup stopped mid-Match: void, both entries are back. */
export const BlockPuzzleVoid = noScores("refunded", 5);
export const BlockPuzzleRefunded = noScores("refunded", null);
export const BlockPuzzleWonBacked = blockPuzzle("won", { stage: "settled", reason: 1 }, { backing: "player" });
export const BlockPuzzleBackerWatching = blockPuzzle("active", { stage: "backer" }, { backing: "backer" });
export const BlockPuzzleBackerWon = blockPuzzle("won", { stage: "settled", reason: 1 }, { backing: "backer" });
/** The Player is backed and nobody has joined: Cancel hands the Gemas back to the Backer. */
export const BlockPuzzleBackedWaiting = blockPuzzle("open", { stage: "waiting" }, { backing: "player" });
/** A backed Player lost: the Backer's share of the entry is gone too, shown under the result. */
export const BlockPuzzleLostBacked = blockPuzzle("lost", { stage: "settled", reason: 1 }, { backing: "player" });
/** The Backer's Player lost the Match. */
export const BlockPuzzleBackerLost = blockPuzzle("lost", { stage: "settled", reason: 1 }, { backing: "backer" });
/** Past the time the Match should have settled, refund deadline still ahead: "Delayed, refunds by …". */
export const BlockPuzzleDelayed = blockPuzzleLate(false);
/** Past the settle time and the refund deadline: "Delayed, refund is open" with a Refund Match button. */
export const BlockPuzzleDelayedRefundOpen = blockPuzzleLate(true);
/** Someone else's Match: read-only. */
export const BlockPuzzleSpectator = blockPuzzle("spectator", { stage: "spectator" });
export const BlockPuzzleSignedOut = signedOut(blockPuzzle("spectator", { stage: "spectator" }));
export const BlockPuzzleNotFound: Story = { render: () => <MatchView matchId="404" />, parameters: { spectated: null, screen: { burst: { stage: "notfound" } } } };
/** The same live screens on a phone. */
export const BlockPuzzleLivePhone = phone(table("playing"));
export const BlockPuzzleLastTenSecondsPhone = phone(table("last10"));
export const BlockPuzzleWaitingForTablePhone = phone(table("table"));
export const BlockPuzzleGetReadyPhone = phone(table("getReady"));
export const BlockPuzzleWonPhone = phone(blockPuzzle("won", { stage: "settled", reason: 1 }));

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
/* Vanguard, rank powers */
/** Your turn with the powers in reach. Tap the Engineer (Blast outlines its 8 squares), the Colonel (Rescue arrow), the Major (Dig in) or the 10 (Become a Spy). */
export const VanguardPowers = vanguard("active", vp.powerTurn());
export const VanguardPowersPhone = phone(vanguard("active", vp.powerTurn()));
/** Their Engineer blasts beside your pieces: it flips face up, and your two pieces it showed glow red. */
export const VanguardTheirBlast = vanguard("active", vp.theirBlast());
/** Their Colonel blows up and their Truck flies to its square, face up. */
export const VanguardTheirRescue = vanguard("active", vp.theirRescue());
/** They pass. A face-down Dig in reads exactly the same: nothing here tells the two apart. */
export const VanguardTheirPass = vanguard("active", vp.theirPass());
export const VanguardTheirDigInLooksLikeAPass = vanguard("active", vp.theirPass(true));
/** Reloaded after a Dig in and a switch: the Major wears a Landmine with a Major badge, the 10 a Spy with a 10 badge. */
export const VanguardReloadedWithChanges = vanguard("active", vp.reloadedWithChanges());
/** You dug a Major in: the Battle shows a pass, your own Army tells you ("Dug in"). */
export const VanguardYourDugIn = vanguard("active", vp.yourDugIn());
/** The end of the Match lists the pieces whose rank changed. */
export const VanguardEndChanged = vanguard("active", vp.endChanged());
export const VanguardWon = vanguard("won", { stage: "settled" });
export const VanguardLost = vanguard("lost", { stage: "settled" });
export const VanguardRefunded = vanguard("refunded", { stage: "settled" });
export const VanguardSpectator = vanguard("spectator", { stage: "spectator", seat: null });
