import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { VanguardMatchView } from "@/games/vanguard/VanguardMatchView";
import type { ChainMatch } from "@/lib/chain/read";
import { withSpectated } from "../components/support/spectated";
import { chainMatch, type MatchState } from "./support/matches";
import { withScreen, type ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";
import * as clock from "./support/vanguard-clock";

const meta = {
  title: "Screens/Match/Vanguard clock and endings",
  decorators: [withSigner, withScreen, withSpectated],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const route = (m: ChainMatch) => ({ nextjs: { navigation: { pathname: `/play/match/${m.id}` } } });

function vanguard(state: MatchState, view: ScreenData["vanguard"]): Story {
  const m = chainMatch("vanguard", state);
  return { render: () => <VanguardMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { vanguard: { match: m, seat: m.seat, ...view } } } };
}

const phone = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone390", isRotated: false } } });

/** The opening turn: the ring stays full through the opening grace, then runs the 5 seconds. */
export const RingOpeningTurn = vanguard("active", clock.ringOpening());
/** Your turn has just begun: the ring around your avatar is full. */
export const RingFull = vanguard("active", clock.ringFull());
/** 3.5 seconds into your turn: the ring is nearly empty and amber. */
export const RingLow = vanguard("active", clock.ringLow());
export const RingLowPhone = phone(vanguard("active", clock.ringLow()));

/** You have missed two turns, they have missed one: "Missed 2 of 3" in amber, "Missed 1 of 3" beside it. */
export const MissedTurns = vanguard("active", clock.missedCounts());
export const MissedTurnsPhone = phone(vanguard("active", clock.missedCounts()));

/** Each reason a Match ends, on the table while the result is being saved. */
export const EndedTruckWon = vanguard("active", clock.endTruckWon());
export const EndedTruckLost = vanguard("active", clock.endTruckLost());
export const EndedStuckWon = vanguard("active", clock.endStuckWon());
export const EndedStuckLost = vanguard("active", clock.endStuckLost());
export const EndedTimeoutsWon = vanguard("active", clock.endTimeoutsWon());
export const EndedTimeoutsLost = vanguard("active", clock.endTimeoutsLost());
export const EndedCapWon = vanguard("active", clock.endCapWon());
export const EndedCapLost = vanguard("active", clock.endCapLost());
export const EndedCapDrawn = vanguard("active", clock.endCapDrawn());
export const EndedCancelled = vanguard("active", clock.endCancelled());
export const EndedTimeoutsLostPhone = phone(vanguard("active", clock.endTimeoutsLost()));

/** The same reasons on the result screen once the Pot is paid. */
export const ResultWonOnTime = vanguard("won", clock.settledAs(clock.endTimeoutsWon()));
export const ResultLostOnTime = vanguard("lost", clock.settledAs(clock.endTimeoutsLost()));
export const ResultDrawnOnTheLimit = vanguard("refunded", clock.settledAs(clock.endCapDrawn()));
export const ResultCancelled = vanguard("refunded", clock.settledAs(clock.endCancelled()));
