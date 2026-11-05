import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState } from "react";
import { RailcarScreen, type RailcarBrake, type RailcarWatch } from "@/games/railcar/RailcarScreen";
import { RideHistory } from "@/games/railcar/RideHistory";
import * as fx from "@/games/railcar/fixtures";
import type { RailcarView } from "@/games/railcar/view";

const meta = {
  title: "Games/Railcar",
  parameters: { layout: "padded", shell: "app", nextjs: { navigation: { pathname: "/play/railcar" } } },
} satisfies Meta;
export default meta;

const noop = () => undefined;
const actions = { onBoard: noop, onStepOff: noop, onJump: noop, onPlayAgain: noop, onShare: noop, onAddFriend: noop, onSignIn: noop };
const screen = (view: RailcarView, o: { busy?: string; error?: string; brake?: RailcarBrake; watch?: RailcarWatch } = {}): StoryObj => ({
  render: () => <RailcarScreen view={view} actions={actions} busy={o.busy ?? null} error={o.error ?? null} brake={o.brake ?? null} watch={o.watch ?? null} />,
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
/** A record the replay does not give (Ana shown 400 back where the schedule gives 350): the page lists the difference. */
export const RideFromHistoryDiffers = history(fx.storedWorkedRide({ tamper: true }), fx.ANA.toBase58());
