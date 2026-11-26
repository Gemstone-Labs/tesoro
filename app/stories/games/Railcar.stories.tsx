import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { isMuted, subscribeMuted } from "@/games/fx/sfx";
import { brakeState, type BrakeFacts, type TellCue } from "@/games/railcar/brake";
import { Button } from "@/components/ui";
import { PrizePile, RailcarScreen, type RailcarBrake, type RailcarOffer, type RailcarWatch } from "@/games/railcar/RailcarScreen";
import { RailcarWaiting } from "@/games/railcar/RailcarWaiting";
import { RailcarStage } from "@/games/railcar/RailcarStage";
import { RailcarShowcase } from "@/games/railcar/showcase";
import { RideHistory } from "@/games/railcar/RideHistory";
import { playTells, railcarHaptics } from "@/games/railcar/tells";
import * as fx from "@/games/railcar/fixtures";
import { hexToBytes } from "@/games/railcar/engine";
import { RailcarPractice } from "@/games/railcar/practice/RailcarPractice";
import { newPractice, practiceBrake, practiceJump, practiceView, type Practice } from "@/games/railcar/practice/session";
import { tellsUpTo, type Tells } from "@/games/railcar/tell-state";
import type { RailcarView } from "@/games/railcar/view";
import { PublicKey } from "@solana/web3.js";
import { matchPda } from "@/lib/chain/basket";
import { demoSnapshot } from "@/lib/chain/fixture";

const meta = {
  title: "Games/Railcar",
  parameters: { layout: "padded", shell: "app", nextjs: { navigation: { pathname: "/play/railcar" } } },
} satisfies Meta;
export default meta;

const noop = () => undefined;
const actions = { onBoard: noop, onStepOff: noop, onJump: noop, onPlayAgain: noop, onShare: noop, onAddFriend: noop, onSignIn: noop };
const screen = (view: RailcarView, o: { busy?: string; error?: string; brake?: RailcarBrake; offer?: RailcarOffer; watch?: RailcarWatch; waiting?: ReactNode } = {}): StoryObj => ({
  render: () => <RailcarScreen view={view} actions={actions} busy={o.busy ?? null} error={o.error ?? null} brake={o.brake ?? null} offer={o.offer ?? null} watch={o.watch ?? null} waiting={o.waiting ?? null} />,
});
const phone = { globals: { viewport: { value: "phone390", isRotated: false } } };
const desk = { globals: { viewport: { value: "desktop1440", isRotated: false } } };

/** Boarding below 5 Players: no countdown yet, the car waits with no time limit. */
export const BoardingWaiting = screen(fx.boardingWaiting());
/** Boarding from the 5th Player: 30 s to the fixed departure time. You are in seat 14. */
export const BoardingCountdown = screen(fx.boardingCountdown());
/** The boarding car, seen by a Player who has not boarded yet. */
export const BoardingNotAboard = screen(fx.boardingNotAboard());
/** Step off sent: the button says so until it lands. */
export const SteppingOff = screen(fx.boardingCountdown(), { busy: "step-off" });

/** The car just left: the screen is already the Ride and the car rolls; the clock waits at 0:00 for the draw. */
export const RideStarting = screen(fx.rideStarting());
/** The car left 5 minutes ago and its ride never started: Delayed, with the time every entry refunds (a day after it left). */
export const RideDelayed = { ...screen(fx.rideDelayed()), ...phone };
/** The same Delayed car, watched by someone not in it: no Live chip, no next ride (it would wait behind this car). */
export const RideDelayedWatching = { ...screen(fx.rideDelayed(null), { watch: { signedIn: true, nextSeated: 3 } }), ...phone };
/** A day after it left: the refund is open. */
export const RideDelayedRefundOpen = { ...screen(fx.rideDelayed(fx.PLAYERS[0], true)), ...phone };
/** Mid-ride: 1:12, the first glow heard, 29 of 40 still aboard; the Prize 3,760 (40 x 100 less 6% fees) with 11 entries on the pile. */
export const Riding = screen(fx.riding());
export const Riding390: StoryObj = { ...Riding, ...phone };
/** You jumped at 0:25: last off so far, and you keep watching. Nothing comes back unless fewer than three Jump after you. */
export const RidingAfterYourJump = screen(fx.riding(fx.PLAYERS[0], { jumpedMe: true }));
export const RidingAfterYourJump390: StoryObj = { ...RidingAfterYourJump, ...phone };
const outOfPlaces = (v: RailcarView): RailcarView => (v.phase === "ride" && v.me && !v.me.aboard ? { ...v, me: { ...v.me, after: 3 } } : v);
/** Three Jumped after you: out of the last three, 0. */
export const RidingAfterYourJumpOutOfPlaces = { ...screen(outOfPlaces(fx.riding(fx.PLAYERS[0], { jumpedMe: true }))), ...phone };

// ---- The Prize and the pile (rules round 2, decisions Q40) -----------------------------------------------------------

/** At departure: the Prize is fixed (5 x 100 less 6% fees = 470) and nothing is on the pile yet. */
export const PrizePileAtDeparture: StoryObj = { render: () => <PrizePile prize={470n} pile={0} />, ...phone };
/** Two Jumped: their entries lie on the pile; the Prize still reads 470. */
export const PrizePileTwoJumped: StoryObj = { render: () => <PrizePile prize={470n} pile={2} />, ...phone };
/** A 100-seat car with 37 Jumped: 8 entries drawn, the rest as +29; the Prize 9,400 never moves. */
export const PrizePileFullCar: StoryObj = { render: () => <PrizePile prize={9_400n} pile={37} />, ...phone };
/** Live: a Jump every 1.2 s drops one entry onto the pile (the newest falls in); the Prize number stays 470 the whole time. Loops. */
export const PrizePileDropping: StoryObj = {
  render: function Dropping() {
    const [n, setN] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setN((x) => (x >= 5 ? 0 : x + 1)), 1_200);
      return () => clearInterval(id);
    }, []);
    return <PrizePile prize={470n} pile={n} />;
  },
  ...phone,
};
const brake = (o: Partial<BrakeFacts>): RailcarBrake => ({ ...brakeState({ aboard: true, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: null, pending: false, rideMs: 72_000, ...o })!, onBrake: noop });
/** Your Brake, ready: one per ride, halves the car for 5 s, only you see it. */
/** The base RPC refused reads (429): a plain line, never the raw reply. It goes away on the next read that works. */
export const ReadsBusy = screen(fx.boardingCountdown(), { error: "The network is busy right now. Wait a few seconds and try again." });
export const ReadsBusy390: StoryObj = { ...ReadsBusy, ...phone };
export const ReadsBusy1440: StoryObj = { ...ReadsBusy, ...desk };

export const RidingBrakeReady = screen(fx.riding(), { brake: brake({}) });
/** Pressed: it rides on your page's next tick (no transaction of its own). */
export const RidingBrakeSending = screen(fx.riding(), { brake: brake({ pending: true }) });
/** Your own Brake running: the car slows on your screen only, the tag counts your 5 s. */
export const RidingWithYourBrake = screen(fx.riding(), { brake: brake({ pressMs: 68_600 }) });
/** Used: no more Brakes this ride. */
export const RidingBrakeUsed = screen(fx.riding(), { brake: brake({ pressMs: 40_000 }) });
/** Not every seat is bound yet (the first seconds of the ride): the Brake waits. */
export const RidingBrakeWaiting = screen(fx.riding(), { brake: brake({ allBound: false }) });
/** Riding without a seat key on this device: the wallet signs once as the ride starts so the Brake stays secret; until it has, the button asks for it. */
export const RidingBrakeSignFirst = screen(fx.riding(), { brake: brake({ walletCopied: false }) });
/** Ben's screen while Ana's Brake runs: exactly the Riding screen. */
export const RidingAnothersBrake = screen(fx.riding(fx.BEN), { brake: brake({}) });
/** You jumped after your Brake: your place so far, as after any Jump (a Brake never changes what an early Jump gets: nothing). */
export const RidingAfterYourBrakeAndJump = screen(fx.riding(fx.PLAYERS[0], { jumpedMe: true, myBrakeMs: 15_000 }));
const withTells = (v: RailcarView, tells: Tells): RailcarView => (v.phase === "ride" ? { ...v, tells } : v);
const withTell = (v: RailcarView, stage: number): RailcarView => withTells(v, tellsUpTo(stage));
/** The bomb inside warns on the car itself from the moment each Tell fires: a faint amber light under the car and at the door seams (it flares at each screw heard)... */
export const RidingTellScrews = screen(withTell(fx.riding(), 1));
/** ...then an orange glow under the chassis and through the doors, the windows dim amber... */
export const RidingTellPanel = screen(withTell(fx.riding(), 2));
/** ...then the whole body outlined in hot light, the windows white-hot. The latest stays to the end of the ride. */
export const RidingTellSparks = screen(withTell(fx.riding(), 3));
/** A later Tell is not promised: this ride shows the white-hot step and never the seams (three glows heard, false and real alike). */
export const RidingSparksNoPanel = screen(withTells(fx.riding(), { screws: 3, panel: false, sparks: true }));
/** This ride shows the first glow and nothing else: the bomb can go off with no further warning. */
export const RidingScrewsOnly = screen(withTells(fx.riding(), { screws: 4, panel: false, sparks: false }));

/** The explosion: the ride turns into its Result, the bomb goes off inside the car (shake, three frames, about a second), then the Result. Loops. */
export const CrashBeforeResult: StoryObj = {
  render: function Crash() {
    const [n, setN] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setN((x) => x + 1), 5_000);
      return () => clearInterval(id);
    }, []);
    return <CrashCycle key={n} />;
  },
};
function CrashCycle() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setOver(true), 1_500);
    return () => clearTimeout(id);
  }, []);
  return <RailcarScreen view={over ? fx.workedResult() : withTell(fx.riding(), 3)} actions={actions} />;
}

/** The explosion on its own (no Result timer): the car stopped, the shake, and the three picked frames play over the car in about a second: windows blow out, the blast, the wreck held to the end. */
export const CrashImpact: StoryObj = {
  render: () => (
    <div className="rc" style={{ maxWidth: 640 }}>
      <RailcarStage aboard={[]} moving={false} crash tells={tellsUpTo(3)} />
    </div>
  ),
};

/** A whole ride in about 14 s, no waiting: the car leaves and speeds up, the first glow, your Brake (half speed for 5 s), the glowing seams, white-hot, the bomb going off (shake, three frames), then the Result. Replay restarts it. The real screen on a fixture with a fast ride clock. */
export const Showcase: StoryObj = { render: () => <RailcarShowcase /> };

/** A Player watching a car they are not in. */
export const RidingWatching = screen(fx.riding(null));

/** The worked example, as Dee (last off): 203 / 142 / 125 / 0 / 0, fees 30, the bomb at 0:30. */
export const ResultLastOff = screen(fx.workedResult());
export const ResultLastOff390: StoryObj = { ...ResultLastOff, ...phone };
/** The worked example as Ben (second-last off). */
export const ResultSecondLastOff = screen(fx.workedResult(fx.BEN));
/** The worked example as Ana: jumped early at 0:08, "Jumped early" and 0, the same as a seat aboard at the blast. */
export const ResultJumpedEarly = screen(fx.workedResult(fx.ANA));
export const ResultJumpedEarly390: StoryObj = { ...ResultJumpedEarly, ...phone };
/** The worked example as Eve (aboard at the blast). */
export const ResultAboardAtImpact = screen(fx.workedResult(fx.EVE));
/** The ride paid 350 Gemas into a full Account: one line under the amount says how many wait for room, with Claim. */
const CAR = new PublicKey(new Uint8Array(32).fill(9));
export const ResultWaitingForRoom: StoryObj = {
  ...screen(fx.workedResult(), { waiting: <RailcarWaiting match={matchPda(CAR, 7)} /> }),
  parameters: {
    data: {
      snapshot: (a: string) => ({
        ...demoSnapshot(a),
        waiting: [{ address: CAR, owner: CAR, payer: CAR, kind: 0, match: matchPda(CAR, 7), gemas: 350n, lines: 1, storeLines: [], sources: [CAR] }],
      }),
    },
  },
};
/** Nobody jumped: every entry back, no fees. */
export const ResultNobodyJumped = screen(fx.nobodyJumped());

// ---- Backing (ticket 13): Ben rides with Bob's Gemas, keeping 40% of any winnings --------------------------------------

const BOB = fx.BOB.toBase58();
const benBacked = { seat: 1, backer: fx.BOB, shareBps: 4_000 };

/** `/play/railcar?backing=<offer>`: Bob's accepted Offer, before boarding. Their 100 board for you. */
export const BoardingWithBacking = screen(fx.boardingCountdown(null), { offer: { backer: BOB, sharePct: 40 } });
/** Bob already has a seat in this car: the Offer waits for the next one (core would refuse it here). */
export const BoardingBackerInThisCar = screen(fx.boardingCountdown(null), { offer: { backer: BOB, sharePct: 40, blocked: "Your Backer is in this car: board the next one" } });
/** Boarded with Bob's Gemas: a step-off sends the full 100 back to Bob. */
export const BoardingBackedAboard = screen(fx.boardingCountdown(fx.BEN, benBacked));
/** Ana jumped under Bob's Backing: her place so far; Bob gets his entry back only if she ends in the last three. */
export const RidingBackedAfterJump = screen(fx.riding(fx.ANA, { jumpedMe: true, backed: { ...benBacked, seat: 0 } }));
/** The worked example as Ben, backed: 142 back, Bob 126 (his 100 first), Ben 16 (40% of 42). */
export const ResultBackedSecondLastOff = screen(fx.workedResult(fx.BEN, benBacked));
/** Backed and aboard at Impact: Bob bears the 100, Eve owes nothing. */
export const ResultBackedAboard = screen(fx.workedResult(fx.EVE, { ...benBacked, seat: 4 }));
/** Someone else's backed place on the result: Ben's plate shows the split. */
export const ResultWithABackedPlace = screen(fx.workedResult(fx.DEE, benBacked));

/** Boarding turns into the Ride in place: the countdown runs out, the same car starts rolling right, Players leap off, then the Result. 4x speed. */
export const LeavesInPlace: StoryObj = {
  render: function Live() {
    const [t, setT] = useState(20);
    useEffect(() => {
      const id = setInterval(() => setT((x) => (x > 80 ? 20 : x + 0.25)), 250 / 4);
      return () => clearInterval(id);
    }, []);
    return <RailcarScreen view={fx.liveAt(t)} actions={actions} />;
  },
};

/** The Tells as sound and vibration. Each button plays one cue through the Railcar Tell player; turn sound off (or vibration, on a phone) in the game menu and the cue respects it. */
export const TellsSoundAndVibration: StoryObj = {
  render: function Tells() {
    const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
    const vibration = useSyncExternalStore(railcarHaptics.subscribe, railcarHaptics.enabled, () => true);
    const cues: [TellCue, string][] = [
      ["screws", "A screw (false and real sound alike)"],
      ["rattle", "Bolt and panel rattle"],
      ["sparks", "Sparks and creak"],
    ];
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
        <RailcarScreen view={fx.riding()} actions={actions} />
        <p className="cut cut-chip" data-testid="tell-settings">
          Sound {muted ? "off" : "on"} · Vibration {vibration ? "on" : "off"}
        </p>
        {cues.map(([cue, label]) => (
          <Button key={cue} block onClick={() => playTells([cue])}>
            {label}
          </Button>
        ))}
      </div>
    );
  },
};

// ---- Spectators (sp1) ----------------------------------------------------------------------------------------------

/** Someone signed out watching the live ride from a shared link: the same view as a Player who has not Braked, Live, and the next ride (sign in first). */
export const Spectating = screen(fx.riding(null), { watch: { signedIn: false, nextSeated: 12 } });
export const Spectating390: StoryObj = { ...Spectating, ...phone };
export const Spectating1440: StoryObj = { ...Spectating, ...desk };
/** Signed in, not in this car: Play the next ride boards the car that is boarding. */
export const SpectatingSignedIn = screen(fx.riding(null), { watch: { signedIn: true, nextSeated: 12 } });
/** The ride they watched ended: its Result, and the next ride. */
export const SpectatorResult = screen(fx.workedResult(null), { watch: { signedIn: true, nextSeated: 3 } });
export const SpectatorResult390: StoryObj = { ...SpectatorResult, ...phone };

// ---- Round history: a finished ride's page --------------------------------------------------------------------------

const history = (page: ReturnType<typeof fx.storedWorkedRide>, me: string | null): StoryObj => ({ render: () => <RideHistory page={page} me={me} actions={actions} /> });
/** The worked example from the history, as Dee (last off): the Result, then the bomb, the warnings, the draw and the replay's check. */
export const RideFromHistory = history(fx.storedWorkedRide(), fx.DEE.toBase58());
export const RideFromHistory390: StoryObj = { ...RideFromHistory, ...phone };
export const RideFromHistory1440: StoryObj = { ...RideFromHistory, ...desk };
/** Dee Braked at 0:20: the bomb stays at 0:30 of track and goes off at 0:32 on the clock. Seen by someone who did not ride. */
export const RideFromHistoryWithBrake = history(fx.storedWorkedRide({ brake: true }), null);
/** A ride that did not show the sparks: the check lists the Tell as "Did not show". */
export const RideFromHistoryNoSparks = history(fx.storedWorkedRide({ shows: { sparks: false } }), null);
export const RideFromHistoryWithBrake390: StoryObj = { ...RideFromHistoryWithBrake, ...phone };
/** A car core refunded before anyone revealed its ride: nothing to replay, and the page says so. */
export const RideRefundedUnrevealed: StoryObj = { render: () => <RideHistory page={{ id: "Opener1-7", entry: 100, ride: null, refunded: true }} me={null} actions={actions} /> };
export const RideRefundedUnrevealed390: StoryObj = { ...RideRefundedUnrevealed, ...phone };
export const RideRefundedUnrevealed1440: StoryObj = { ...RideRefundedUnrevealed, ...desk };
/** A record the replay does not give (Ana shown 40 back where round 2 gives nothing): the page lists the difference. */
export const RideFromHistoryDiffers = history(fx.storedWorkedRide({ tamper: true }), fx.ANA.toBase58());
const backedHistory = fx.storedWorkedRide({ deeBackedBy: { funder: fx.BOB.toBase58(), shareBps: 4_000 } });
/** Dee rode on Bob's Backing, 40% to Dee: core paid place 1 its 60% share; the split shown by the Offer (Bob 162 with his 100 first, Dee 41). */
export const RideFromHistoryBacked: StoryObj = { ...history(backedHistory, fx.DEE.toBase58()), ...phone };
/** Someone paid 10 Gemas to the wrong place (Dee 193, Ben 152: places and total right): the check names both amounts. */
export const RideFromHistoryWrongAmount: StoryObj = {
  ...history(
    (() => {
      const page = fx.storedWorkedRide();
      return { ...page, ride: { ...page.ride, places: page.ride.places.map((x, i) => (i === 0 ? { ...x, won: x.won - 10 } : i === 1 ? { ...x, won: x.won + 10 } : x)) } };
    })(),
    null,
  ),
  ...phone,
};

// ---- Practice free (ticket 20): you and 9 simulated riders, the real engine, nothing staked ------------------------

/** A fixed draw: the bomb at 0:36.9, the Glow at 0:22, Hot seams at 0:28, White-hot at 0:33.7; two riders off in the first 10 s, five by 0:25. */
const PRACTICE_DRAW = hexToBytes("b8c8dcecf8081c2c38485c6c78889cacb8c8dcecf8081c2c38485c6c78889cac");
const practiceRide = newPractice(PRACTICE_DRAW);
const practiceBrakeOf = (p: Practice, t: number): RailcarBrake => ({ ...brakeState({ aboard: p.jumpMs === null, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: p.brakeMs, pending: false, rideMs: t })!, onBrake: noop });
const practice = (p: Practice, t: number): StoryObj => ({
  render: () => <RailcarScreen view={practiceView(p, t)} practice brake={p.jumpMs === null ? practiceBrakeOf(p, t) : null} actions={{ onJump: noop, onPlayAgain: noop }} />,
});

/** `/play/practice?game=railcar`, live: the car leaves at once with 9 simulated riders. Jump, Brake and Play again work; nothing is sent. */
export const PracticeLive: StoryObj = { render: () => <RailcarPractice draw={PRACTICE_DRAW} /> };
/** A later Tell is not promised: this ride shows the Glow (0:14.7) and Hot seams (0:15.6) and never White-hot; the bomb goes off at 0:24. Live, so the chips, the car and the simulated riders can be watched to the Result. */
export const PracticeLiveNoSparks: StoryObj = { render: () => <RailcarPractice draw={hexToBytes("0a4c74bd1eb7dd886217c7597294d3af3a16eb1314e2fd38c500a62ad96023e2")} /> };
/** Mid-ride at 0:30: the PRACTICE tag, the riders' names, Jump and your Brake (no Prize: nothing is staked). */
export const PracticeRiding = practice(practiceRide, 30_000);
export const PracticeRiding390: StoryObj = { ...PracticeRiding, ...phone };
export const PracticeRiding1440: StoryObj = { ...PracticeRiding, ...desk };
/** Your Brake running: the car slows on your screen, as in a real ride. */
export const PracticeWithYourBrake = practice(practiceBrake(practiceRide, 28_000), 30_000);
/** You jumped at 0:25: last off so far, and you keep watching. */
export const PracticeAfterYourJump = practice(practiceJump(practiceRide, 25_000), 30_000);
/** Last off at 0:34: what a 100 entry would have paid (484), Play again and Ride for real. */
export const PracticeResultLastOff = practice(practiceJump(practiceRide, 34_000), 700_000);
export const PracticeResultLastOff390: StoryObj = { ...PracticeResultLastOff, ...phone };
export const PracticeResultLastOff1440: StoryObj = { ...PracticeResultLastOff, ...desk };
/** Jumped early at 0:15: five Jumped after you, so a 100 entry would have paid nothing. */
export const PracticeResultJumpedEarly = practice(practiceJump(practiceRide, 15_000), 700_000);
/** Held too long: aboard at Impact, 0. */
export const PracticeResultAboard = practice(practiceRide, 700_000);
export const PracticeResultAboard390: StoryObj = { ...PracticeResultAboard, ...phone };
/** The Railcar page before boarding: Board, and Practice free under it. */
export const BoardingNotAboard390: StoryObj = { ...BoardingNotAboard, ...phone };
export const BoardingNotAboard1440: StoryObj = { ...BoardingNotAboard, ...desk };

// ---- Fits the screen (staging feedback 1): Board / Practice free / Jump / Brake with no page scroll ----------------------

const laptop = { globals: { viewport: { value: "laptop1512", isRotated: false } } };
export const BoardingNotAboardLaptop: StoryObj = { ...BoardingNotAboard, ...laptop };
export const BoardingAboardLaptop: StoryObj = { ...BoardingWaiting, ...laptop };
export const BoardingAboard390: StoryObj = { ...BoardingWaiting, ...phone };
export const BoardingAboard1440: StoryObj = { ...BoardingWaiting, ...desk };
export const RidingBrakeReadyLaptop: StoryObj = { ...RidingBrakeReady, ...laptop };
export const RidingBrakeReady390: StoryObj = { ...RidingBrakeReady, ...phone };
export const RidingBrakeReady1440: StoryObj = { ...RidingBrakeReady, ...desk };
export const PracticeRidingLaptop: StoryObj = { ...PracticeRiding, ...laptop };
