import { describe, expect, it } from "vitest";
import { NO_PICK, STEP_PPM, stepFor } from "../grid";
import { newGridSession, setPick, stepGridSession } from "./gridSession";
import { seededRng } from "./bot";

const A = 100_00000000n;
const T0 = 1_000_000;
const at = (s: number) => T0 + s * 1000;
const hist = Array.from({ length: 30 }, () => 100);

describe("grid practice session", () => {
  it("starts with the calibrated step and no picks", () => {
    const s = newGridSession(T0, A, "SOL", seededRng(1));
    expect(s.step).toBe(stepFor(A, STEP_PPM.SOL));
    expect(s.picks[0].every((p) => p === NO_PICK)).toBe(true);
  });

  it("accepts your pick until the column locks, then refuses", () => {
    let s = newGridSession(T0, A, "SOL", seededRng(1));
    s = setPick(s, 0, 0, at(19))!;
    s = setPick(s, 0, 1, at(19.9))!;
    expect(s.picks[0][0]).toBe(1);
    expect(setPick(s, 0, 0, at(20))).toBeNull();
    expect(setPick(s, 3, -90, at(0))!.picks[0][3]).toBe(-90);
    expect(setPick(s, 12, 0, at(0))).toBeNull();
    expect(setPick(s, 0, NO_PICK, at(1))!.picks[0][0]).toBe(NO_PICK);
  });

  it("a click just after a lock is refused without throwing and changes nothing", () => {
    const s = setPick(newGridSession(T0, A, "SOL", seededRng(1)), 0, 0, at(19.9))!;
    expect(setPick(s, 0, 2, at(20.1))).toBeNull();
    expect(setPick(s, 0, NO_PICK, at(20.1))).toBeNull();
    expect(s.picks[0][0]).toBe(0);
  });

  it("the bot picks every column before it locks and never afterwards", () => {
    const rng = seededRng(3);
    let s = newGridSession(T0, A, "SOL", rng);
    for (let t = 0; t < 150; t++) {
      s = stepGridSession(s, A, at(t), rng, hist);
      if (t === 21) expect(s.picks[1][0]).not.toBe(NO_PICK);
    }
    s = stepGridSession(s, A, at(150), rng, hist);
    expect(s.picks[1].every((p) => p !== NO_PICK)).toBe(true);
  });

  it("settles at the end: a flat line hits band 0, a Player who picks it wins", () => {
    const rng = seededRng(4);
    let s = newGridSession(T0, A, "SOL", rng);
    s = { ...s, picks: [s.picks[0], Array(12).fill(NO_PICK)], botAt: Array(12).fill(1e9) };
    for (let c = 0; c < 12; c++) s = setPick(s, c, 0, at(0))!;
    for (let t = 0; t <= 150; t++) s = stepGridSession(s, A, at(t), rng, hist);
    expect(s.final?.scores[0]).toBe(1200);
    expect(s.final?.winner).toBe(0);
    expect(stepGridSession(s, A + 1n, at(160), rng, hist)).toBe(s);
  });

  it("equal scores draw", () => {
    const rng = seededRng(5);
    let s = newGridSession(T0, A, "SOL", rng);
    s = { ...s, picks: [s.picks[0], Array(12).fill(NO_PICK)], botAt: Array(12).fill(1e9) };
    for (let t = 0; t <= 150; t++) s = stepGridSession(s, A, at(t), rng, hist);
    expect(s.final?.winner).toBe("draw");
  });

  it("does nothing before the start", () => {
    const s = newGridSession(T0, A, "SOL", seededRng(1));
    expect(stepGridSession(s, A, T0 - 1, seededRng(1), hist)).toBe(s);
  });
});
