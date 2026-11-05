import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState } from "react";
import { RailcarScreen, type RailcarBrake, type RailcarOffer } from "@/games/railcar/RailcarScreen";
import * as fx from "@/games/railcar/fixtures";
import type { RailcarView } from "@/games/railcar/view";

const meta = {
  title: "Games/Railcar",
  parameters: { layout: "padded", shell: "app", nextjs: { navigation: { pathname: "/play/railcar" } } },
} satisfies Meta;
export default meta;

const noop = () => undefined;
const actions = { onBoard: noop, onStepOff: noop, onJump: noop, onPlayAgain: noop, onShare: noop, onAddFriend: noop };
const screen = (view: RailcarView, o: { busy?: string; error?: string; brake?: RailcarBrake; offer?: RailcarOffer } = {}): StoryObj => ({
  render: () => <RailcarScreen view={view} actions={actions} busy={o.busy ?? null} error={o.error ?? null} brake={o.brake ?? null} offer={o.offer ?? null} />,
});

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
/** Your own Brake running (ticket 11 wires the button): the tag shows only while you are aboard. */
export const RidingWithYourBrake = screen(fx.riding(), { brake: { left: 0, activeMs: 3_400 } });
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
