/**
 * How the Railcar stage draws the car rolling, pure. The drawing depends only on elapsed time and the Player's own Brake:
 * never on the hidden crash point, so it cannot show the Impact coming. State lives in one `Roll` carried frame to frame; a
 * Brake changes the speed the next frame uses and nothing else, so the picture never jumps when it starts or ends.
 */

/** Background scroll at full speed, px/s, far to near. */
export const SPEED = { far: 14, mid: 40, trk: 130 };
/** The speed the roll settles at, as a share of `SPEED`. Constant for the whole ride. */
export const FULL_SPEED = 1;
/** While the Player's own Brake runs. */
export const BRAKE_SPEED = 0.5;
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
  /** Current share of full speed. */
  speed: number;
}

/** The car at rest, about to pull away. */
export const newRoll = (): Roll => ({ t: null, far: 0, mid: 0, trk: 0, speed: 0 });

/** The next frame at time `t` (ms); `slow` is the Player's own Brake running. Frames longer than 100 ms count as 100. */
export function rollFrame(r: Roll, t: number, slow: boolean): Roll {
  const dt = r.t === null ? 0 : Math.min((t - r.t) / 1000, 0.1);
  const target = slow ? BRAKE_SPEED : FULL_SPEED;
  const speed = r.speed + (target - r.speed) * Math.min(dt * EASE, 1);
  return { t, far: r.far - SPEED.far * speed * dt, mid: r.mid - SPEED.mid * speed * dt, trk: r.trk - SPEED.trk * speed * dt, speed };
}
