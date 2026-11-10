"use client";

/**
 * A short ride that plays itself, for Storybook: the real `RailcarScreen` (so the real stage, Tells, Brake and crash) driven by a
 * fixture and a fake ride clock that runs about 9x faster than real time, so the whole ride (speed-up, three Tells, the Player's
 * Brake, the wall) shows in 14 s. Only the clock is compressed: the ride rules are untouched. Nothing here ships in the app.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { brakeState } from "./brake";
import { rideShow, workedResult } from "./fixtures";
import { RailcarScreen, type RailcarBrake } from "./RailcarScreen";
import type { RailcarView } from "./view";

/** The showcase timeline, in real ms from the departure. */
const SCREWS_AT = 3_000;
const BRAKE_AT = 4_500;
const PANEL_AT = 6_500;
const SPARKS_AT = 9_000;
const JUMPS: [number, number][] = [
  [2_000, 5],
  [5_500, 8],
  [8_000, 11],
];
export const SHOWCASE_CRASH_MS = 11_500;
/** The crash holds the ride screen for a second before the Result, then the Result rests for a moment. */
export const SHOWCASE_MS = SHOWCASE_CRASH_MS + 1_000 + 1_500;
/** The wall of the worked example is at 1:44 of ride clock: the fake clock gets there as the car hits it. */
const CLOCK_X = 104_000 / SHOWCASE_CRASH_MS;

export interface ShowcaseFrame {
  view: RailcarView;
  brake: RailcarBrake | null;
}

/** What the screen shows `ms` after the departure. */
export function showcaseAt(ms: number): ShowcaseFrame {
  if (ms >= SHOWCASE_CRASH_MS) return { view: workedResult(), brake: null };
  const tell = ms >= SPARKS_AT ? 3 : ms >= PANEL_AT ? 2 : ms >= SCREWS_AT ? 1 : 0;
  const jumped = JUMPS.filter(([at]) => ms >= at).map(([, seat]) => seat);
  const view = rideShow(Math.round(ms * CLOCK_X), tell, jumped);
  // The Brake runs on the real showcase clock so its 5 s are real seconds on screen.
  const state = brakeState({ aboard: true, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: ms >= BRAKE_AT ? BRAKE_AT : null, pending: false, rideMs: ms })!;
  return { view, brake: { ...state, onBrake: () => undefined } };
}

/** The showcase clock moves on by `dt` and stops at the end. */
export const showcaseStep = (ms: number, dt: number) => Math.min(ms + dt, SHOWCASE_MS);

const actions = { onBoard: () => undefined, onStepOff: () => undefined, onJump: () => undefined, onPlayAgain: () => undefined, onShare: () => undefined, onAddFriend: () => undefined, onSignIn: () => undefined };

function Run() {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setMs((m) => showcaseStep(m, dt));
    }, 50);
    return () => clearInterval(id);
  }, []);
  const { view, brake } = showcaseAt(ms);
  return <RailcarScreen view={view} actions={actions} brake={brake} />;
}

/** The self-playing ride, with a Replay button that stays above the ride's window cover. */
export function RailcarShowcase() {
  const [run, setRun] = useState(0);
  return (
    <>
      <Run key={run} />
      <div style={{ position: "fixed", top: 12, right: 12, zIndex: 70 }}>
        <Button size="sm" onClick={() => setRun((r) => r + 1)}>
          Replay
        </Button>
      </div>
    </>
  );
}

