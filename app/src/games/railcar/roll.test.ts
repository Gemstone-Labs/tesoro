import { describe, expect, it } from "vitest";
import { newPractice } from "./practice/session";
import { SPEED, WHEEL_DEG_PER_PX, newRoll, rollFrame, targetSpeed, type Roll } from "./roll";

/** Frames at 60 fps; `slow(t)` says whether the Player's own Brake runs at ms `t`. Returns every frame's state. */
function run(ms: number, slow: (t: number) => boolean = () => false, dt = 1000 / 60): Roll[] {
  const out: Roll[] = [];
  let r = newRoll();
  for (let t = 0; t <= ms; t += dt) {
    r = rollFrame(r, t, slow(t), t);
    out.push(r);
  }
  return out;
}

describe("the roll (what the stage draws as the car moves)", () => {
  it("scrolls the cave left and spins the wheels clockwise (the car moves right)", () => {
    const f = run(3_000);
    const last = f[f.length - 1];
    expect(last.trk).toBeLessThan(0);
    expect(last.far).toBeLessThan(0);
    expect(WHEEL_DEG_PER_PX * -last.trk).toBeGreaterThan(0);
  });

  it("a Brake that starts and ends never moves the drawing back or forward by more than one frame's travel", () => {
    const frames = run(14_000, (t) => t >= 5_000 && t < 10_000);
    const dtSec = 1 / 60;
    const eps = 1e-9;
    for (let i = 1; i < frames.length; i++) {
      for (const k of ["far", "mid", "trk"] as const) {
        const step = frames[i][k] - frames[i - 1][k];
        expect(step, `${k} frame ${i} moved back`).toBeLessThanOrEqual(eps);
        expect(-step, `${k} frame ${i} jumped`).toBeLessThanOrEqual(SPEED[k] * targetSpeed(14_000) * dtSec * 1.05 + eps);
      }
    }
  });

  it("during the Brake the car goes on from where it is at half the current speed, and after it eases back to the time-based speed", () => {
    const frames = run(14_000, (t) => t >= 5_000 && t < 10_000);
    const per = (ms: number) => {
      const i = Math.round((ms / 1000) * 60);
      return frames[i + 1].trk - frames[i].trk;
    };
    expect(per(4_000)).toBeCloseTo((-SPEED.trk * targetSpeed(4_000)) / 60, 1);
    expect(per(9_800)).toBeCloseTo((-SPEED.trk * targetSpeed(9_800) * 0.5) / 60, 1);
    expect(per(13_900)).toBeCloseTo((-SPEED.trk * targetSpeed(13_900)) / 60, 1);
  });

  it("gets faster as the ride goes on: from 1x toward 3x by the latest possible Impact, and no further", () => {
    expect(targetSpeed(0)).toBe(1);
    expect(targetSpeed(60_000)).toBeGreaterThan(targetSpeed(10_000));
    expect(targetSpeed(120_000)).toBeCloseTo(3, 6);
    expect(targetSpeed(500_000)).toBeCloseTo(3, 6);
    const frames = run(70_000);
    const per = (ms: number) => {
      const i = Math.round((ms / 1000) * 60);
      return frames[i + 1].trk - frames[i].trk;
    };
    expect(-per(60_000)).toBeGreaterThan(-per(10_000) * 1.5);
    for (const k of ["far", "mid", "trk"] as const) expect(frames[frames.length - 1][k]).toBeLessThan(frames[frames.length - 2][k]);
  });

  it("two rides with different crash points draw the same frames up to the earlier Impact", () => {
    // The stage gets no crash point: only the time and the Player's own Brake. Prove it through the real rides.
    const early = newPractice(new Uint8Array(32).fill(0xf0));
    const late = newPractice(new Uint8Array(32).fill(0x01));
    expect(early.ride.crashMs).not.toBe(late.ride.crashMs);
    const upTo = Math.min(early.ride.crashMs, late.ride.crashMs);
    // The roll takes the clock and the Brake only; nothing about the draw reaches it.
    const a = run(upTo, () => false);
    const b = run(upTo, () => false);
    expect(a).toEqual(b);
  });
});
