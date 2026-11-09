import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isMuted, subscribeMuted } from "@/games/fx/sfx";
import { brakeState, type BrakeFacts, type TellCue } from "@/games/railcar/brake";
import { Button } from "@/components/ui";
import { RailcarScreen, type RailcarBrake, type RailcarOffer, type RailcarWatch } from "@/games/railcar/RailcarScreen";
import { RideHistory } from "@/games/railcar/RideHistory";
import { playTells, railcarHaptics } from "@/games/railcar/tells";
import * as fx from "@/games/railcar/fixtures";
import { hexToBytes } from "@/games/railcar/engine";
import { RailcarPractice } from "@/games/railcar/practice/RailcarPractice";
import { newPractice, practiceBrake, practiceJump, practiceView, type Practice } from "@/games/railcar/practice/session";
import type { RailcarView } from "@/games/railcar/view";

const meta = {
  title: "Games/Railcar",
  parameters: { layout: "padded", shell: "app", nextjs: { navigation: { pathname: "/play/railcar" } } },
} satisfies Meta;
export default meta;

const noop = () => undefined;
const actions = { onBoard: noop, onStepOff: noop, onJump: noop, onPlayAgain: noop, onShare: noop, onAddFriend: noop, onSignIn: noop };
const screen = (view: RailcarView, o: { busy?: string; error?: string; brake?: RailcarBrake; offer?: RailcarOffer; watch?: RailcarWatch } = {}): StoryObj => ({
  render: () => <RailcarScreen view={view} actions={actions} busy={o.busy ?? null} error={o.error ?? null} brake={o.brake ?? null} offer={o.offer ?? null} watch={o.watch ?? null} />,
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
/** Mid-ride: 1:12, screws heard, 29 of 40 still aboard. */
export const Riding = screen(fx.riding());
/** You jumped at 0:25: what came back, and you keep watching. */
export const RidingAfterYourJump = screen(fx.riding(fx.PLAYERS[0], { jumpedMe: true }));
const brake = (o: Partial<BrakeFacts>): RailcarBrake => ({ ...brakeState({ aboard: true, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: null, pending: false, rideMs: 72_000, ...o })!, onBrake: noop });
/** Your Brake, ready: one per ride, halves the car for 5 s, only you see it. */
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
/** You jumped after your Brake: at least what comes back, counting your own Brake. */
export const RidingAfterYourBrakeAndJump = screen(fx.riding(fx.PLAYERS[0], { jumpedMe: true, myBrakeMs: 15_000 }));
/** A Player watching a car they are not in. */
export const RidingWatching = screen(fx.riding(null));

/** The worked example, as Dee (last off): 813 / 630 / 578 / 350 / 0, fees 129, the wall at 1:44. */
export const ResultLastOff = screen(fx.workedResult());
/** The worked example as Ben (second-last off). */
export const ResultSecondLastOff = screen(fx.workedResult(fx.BEN));
/** The worked example as Ana (jumped early at 0:25, 70% back). */
export const ResultJumpedEarly = screen(fx.workedResult(fx.ANA));
/** The worked example as Eve (aboard at Impact). */
export const ResultAboardAtImpact = screen(fx.workedResult(fx.EVE));
/** Nobody jumped: every entry back, no fees. */
export const ResultNobodyJumped = screen(fx.nobodyJumped());

// ---- Backing (ticket 13): Ben rides with Bob's Gemas, keeping 40% of any winnings --------------------------------------

const BOB = fx.BOB.toBase58();
const benBacked = { seat: 1, backer: fx.BOB, shareBps: 4_000 };

/** `/play/railcar?backing=<offer>`: Bob's accepted Offer, before boarding. Their 500 board for you. */
export const BoardingWithBacking = screen(fx.boardingCountdown(null), { offer: { backer: BOB, sharePct: 40 } });
/** Bob already has a seat in this car: the Offer waits for the next one (core would refuse it here). */
export const BoardingBackerInThisCar = screen(fx.boardingCountdown(null), { offer: { backer: BOB, sharePct: 40, blocked: "Your Backer is in this car: board the next one" } });
/** Boarded with Bob's Gemas: a step-off sends the full 500 back to Bob. */
export const BoardingBackedAboard = screen(fx.boardingCountdown(fx.BEN, benBacked));
/** Ben jumped early under the Backing: the refund is Bob's. */
export const RidingBackedAfterJump = screen(fx.riding(fx.ANA, { jumpedMe: true, backed: { ...benBacked, seat: 0 } }));
/** The worked example as Ben, backed: 630 back, Bob 578 (his 500 first), Ben 52 (40% of 130). */
export const ResultBackedSecondLastOff = screen(fx.workedResult(fx.BEN, benBacked));
/** Backed and aboard at Impact: Bob bears the 500, Eve owes nothing. */
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
      ["screws", "Screws (and every false screw)"],
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
/** The worked example from the history, as Dee (last off): the Result, then the wall, the Tells, the draw and the replay's check. */
export const RideFromHistory = history(fx.storedWorkedRide(), fx.DEE.toBase58());
export const RideFromHistory390: StoryObj = { ...RideFromHistory, ...phone };
export const RideFromHistory1440: StoryObj = { ...RideFromHistory, ...desk };
/** Dee Braked at 1:30: the wall stays at 1:44 of track and comes at 1:46 on the clock. Seen by someone who did not ride. */
export const RideFromHistoryWithBrake = history(fx.storedWorkedRide({ brake: true }), null);
export const RideFromHistoryWithBrake390: StoryObj = { ...RideFromHistoryWithBrake, ...phone };
/** A car core refunded before anyone revealed its ride: nothing to replay, and the page says so. */
export const RideRefundedUnrevealed: StoryObj = { render: () => <RideHistory page={{ id: "Opener1-7", entry: 500, ride: null, refunded: true }} me={null} actions={actions} /> };
export const RideRefundedUnrevealed390: StoryObj = { ...RideRefundedUnrevealed, ...phone };
export const RideRefundedUnrevealed1440: StoryObj = { ...RideRefundedUnrevealed, ...desk };
/** A record the replay does not give (Ana shown 400 back where the schedule gives 350): the page lists the difference. */
export const RideFromHistoryDiffers = history(fx.storedWorkedRide({ tamper: true }), fx.ANA.toBase58());

// ---- Practice free (ticket 20): you and 9 simulated riders, the real engine, nothing staked ------------------------

/** A fixed draw: the wall at 1:26, sparks at 1:18; three riders off in the first 25 s. */
const PRACTICE_DRAW = hexToBytes("b8c8dcecf8081c2c38485c6c78889cacb8c8dcecf8081c2c38485c6c78889cac");
const practiceRide = newPractice(PRACTICE_DRAW);
const practiceBrakeOf = (p: Practice, t: number): RailcarBrake => ({ ...brakeState({ aboard: p.jumpMs === null, allBound: true, myBound: true, canSign: true, pressMs: p.brakeMs, pending: false, rideMs: t })!, onBrake: noop });
const practice = (p: Practice, t: number): StoryObj => ({
  render: () => <RailcarScreen view={practiceView(p, t)} practice brake={p.jumpMs === null ? practiceBrakeOf(p, t) : null} actions={{ onJump: noop, onPlayAgain: noop }} />,
});

/** `/play/practice?game=railcar`, live: the car leaves at once with 9 simulated riders. Jump, Brake and Play again work; nothing is sent. */
export const PracticeLive: StoryObj = { render: () => <RailcarPractice draw={PRACTICE_DRAW} /> };
/** Mid-ride at 1:12: the PRACTICE tag, the riders' names, Jump and your Brake. */
export const PracticeRiding = practice(practiceRide, 72_000);
export const PracticeRiding390: StoryObj = { ...PracticeRiding, ...phone };
export const PracticeRiding1440: StoryObj = { ...PracticeRiding, ...desk };
/** Your Brake running: the car slows on your screen, as in a real ride. */
export const PracticeWithYourBrake = practice(practiceBrake(practiceRide, 70_000), 72_000);
/** You jumped at 1:00: at least what a 500 entry would get back, and you keep watching. */
export const PracticeAfterYourJump = practice(practiceJump(practiceRide, 60_000), 72_000);
/** Last off at 1:20: what a 500 entry would have paid, Play again and Ride for real. */
export const PracticeResultLastOff = practice(practiceJump(practiceRide, 80_000), 700_000);
export const PracticeResultLastOff390: StoryObj = { ...PracticeResultLastOff, ...phone };
export const PracticeResultLastOff1440: StoryObj = { ...PracticeResultLastOff, ...desk };
/** Jumped early at 0:15: the refund a 500 entry would have got. */
export const PracticeResultJumpedEarly = practice(practiceJump(practiceRide, 15_000), 700_000);
/** Held too long: aboard at Impact, 0. */
export const PracticeResultAboard = practice(practiceRide, 700_000);
export const PracticeResultAboard390: StoryObj = { ...PracticeResultAboard, ...phone };
/** The Railcar page before boarding: Board, and Practice free under it. */
export const BoardingNotAboard390: StoryObj = { ...BoardingNotAboard, ...phone };
export const BoardingNotAboard1440: StoryObj = { ...BoardingNotAboard, ...desk };
