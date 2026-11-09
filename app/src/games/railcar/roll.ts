/**
 * How the Railcar stage draws the car rolling, pure. The drawing depends only on elapsed time and the Player's own Brake:
 * never on the hidden crash point, so it cannot show the Impact coming. State lives in one `Roll` carried frame to frame; a
 * Brake changes the speed the next frame uses and nothing else, so the picture never jumps when it starts or ends.
 */
import { MAX_CRASH_MS } from "./engine";

/** Background scroll at full speed, px/s, far to near. */
export const SPEED = { far: 14, mid: 40, trk: 130 };
/** The speed at departure and the speed at the latest possible Impact, as shares of `SPEED`: the car gets faster as the ride goes on. */
export const START_SPEED = 1;
export const TOP_SPEED = 3;
/** The Player's own Brake halves whatever the speed is. */
export const BRAKE_FACTOR = 0.5;

/** The speed the roll settles at `rideMs` after departure (before any Brake): linear from 1x to 3x over the longest ride, then flat. Time only. */
export const targetSpeed = (rideMs: number): number => START_SPEED + (TOP_SPEED - START_SPEED) * Math.min(1, Math.max(0, rideMs) / MAX_CRASH_MS);
/** Wheel degrees per px of track travelled: positive turns clockwise, the way a car rolling right turns. */
export const WHEEL_DEG_PER_PX = 1.4;
/** How fast the speed eases to its target, per second (the car pulling away, and the Brake coming on and off). */
const EASE = 2.5;

export interface Roll {
  /** `performance.now()` of the last frame; null before the first. */
  t: number | null;
  /** Background offsets in px (negative: the cave goes left). */
  far: number;
  mid: number;
  trk: number;
  /** Current share of `SPEED`. */
  speed: number;
}

/** The car at rest, about to pull away. */
export const newRoll = (): Roll => ({ t: null, far: 0, mid: 0, trk: 0, speed: 0 });

/** The next frame at time `t` (ms), `rideMs` after departure; `slow` is the Player's own Brake running. Frames longer than 100 ms count as 100. */
export function rollFrame(r: Roll, t: number, slow: boolean, rideMs: number): Roll {
  const dt = r.t === null ? 0 : Math.min((t - r.t) / 1000, 0.1);
  const target = targetSpeed(rideMs) * (slow ? BRAKE_FACTOR : 1);
  const speed = r.speed + (target - r.speed) * Math.min(dt * EASE, 1);
  return { t, far: r.far - SPEED.far * speed * dt, mid: r.mid - SPEED.mid * speed * dt, trk: r.trk - SPEED.trk * speed * dt, speed };
}
