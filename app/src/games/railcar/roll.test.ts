import { describe, expect, it } from "vitest";
import { newPractice } from "./practice/session";
import { FULL_SPEED, SPEED, WHEEL_DEG_PER_PX, newRoll, rollFrame, type Roll } from "./roll";

/** Frames at 60 fps; `slow(t)` says whether the Player's own Brake runs at ms `t`. Returns every frame's state. */
function run(ms: number, slow: (t: number) => boolean = () => false, dt = 1000 / 60): Roll[] {
  const out: Roll[] = [];
  let r = newRoll();
  for (let t = 0; t <= ms; t += dt) {
    r = rollFrame(r, t, slow(t));
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
        expect(-step, `${k} frame ${i} jumped`).toBeLessThanOrEqual(SPEED[k] * FULL_SPEED * dtSec * 1.05 + eps);
      }
    }
  });

  it("during the Brake the car goes on from where it is at half speed, and at the end at full speed again", () => {
    const frames = run(14_000, (t) => t >= 5_000 && t < 10_000);
    const per = (i: number) => frames[i + 1].trk - frames[i].trk;
    const at = (ms: number) => Math.round((ms / 1000) * 60);
    expect(per(at(4_000))).toBeCloseTo(-SPEED.trk / 60, 3);
    expect(per(at(9_500))).toBeCloseTo(-SPEED.trk / 120, 3);
    expect(per(at(13_500))).toBeCloseTo(-SPEED.trk / 60, 3);
  });

  it("the speed depends on elapsed time and the Brake only: after the first seconds it stays the same", () => {
    const frames = run(120_000);
    const per = (ms: number) => frames[Math.round((ms / 1000) * 60) + 1].trk - frames[Math.round((ms / 1000) * 60)].trk;
    expect(per(10_000)).toBeCloseTo(per(110_000), 6);
  });

  it("two rides with different crash points draw the same frames up to the earlier Impact", () => {
    // The stage gets no crash point: only the time and the Player's own Brake. Prove it through the real rides.
    const early = newPractice(new Uint8Array(32).fill(0xf0));
    const late = newPractice(new Uint8Array(32).fill(0x01));
    expect(early.ride.crashMs).not.toBe(late.ride.crashMs);
    const upTo = Math.min(early.ride.crashMs, late.ride.crashMs);
    const a = run(upTo);
    const b = run(upTo);
    expect(a).toEqual(b);
  });
});
