import { describe, expect, it } from "vitest";
import { MATCH_SECS, NO_PICK, newTrack, record } from "./grid";
import { cameraX, hitCount, layoutFor, marks, priceDigits, runEndingAt, snakePath, snakePoints, xOf, yOf } from "./gridView";

const A = 100_00000000n;
const STEP = 25_000000n; // 0.25

describe("camera", () => {
  const l = layoutFor(1000);
  it("holds at the start and the end, and follows the line between", () => {
    expect(cameraX(0, l)).toBe(0);
    expect(cameraX(10, l)).toBe(0);
    expect(cameraX(MATCH_SECS, l)).toBeCloseTo(15 * l.cw - l.viewW);
    const mid = cameraX(80, l);
    expect(mid).toBeCloseTo(xOf(80, l.cw) - l.viewW * l.nowFrac);
  });
  it("steps a whole column at a time when asked", () => {
    expect(cameraX(84, l, true)).toBe(cameraX(80, l, true));
    expect(cameraX(86, l, true)).toBe(cameraX(80, l, true));
  });
});

describe("snake", () => {
  const l = layoutFor(1000);
  it("starts at the anchor, drops samples from before the start, keeps time order", () => {
    const pts = snakePoints(
      [
        { t: 500, p: 99 },
        { t: 3000, p: 100.1 },
        { t: 2000, p: 100.2 },
        { t: 4000, p: 100.3 },
      ],
      1000,
      100,
    );
    expect(pts.map((p) => p.t)).toEqual([0, 2, 3]);
  });
  it("keeps the line inside the frame", () => {
    expect(yOf(500, 100, 0.25, l.rh)).toBeLessThan(10);
    expect(yOf(-500, 100, 0.25, l.rh)).toBeGreaterThan(8 * l.rh - 10);
    expect(yOf(100, 100, 0.25, l.rh)).toBeCloseTo(4 * l.rh);
  });
  it("draws one path and reports its end", () => {
    const p = snakePath(snakePoints([{ t: 1000, p: 100.1 }], 0, 100), l, 100, 0.25);
    expect(p.d.startsWith("M")).toBe(true);
    expect(p.x).toBeCloseTo(xOf(1, l.cw), 0);
  });
  it("prints enough decimals", () => {
    expect([priceDigits(0.6), priceDigits(0.035), priceDigits(0.0108), priceDigits(0.004)]).toEqual([2, 3, 3, 4]);
  });
});

describe("marks", () => {
  it("hits as soon as the line touches, misses only once the column is done", () => {
    let tr = record(newTrack(), 0, A);
    tr = record(tr, 31, A); // column 0, row 4
    const picks = Array.from({ length: 12 }, () => NO_PICK);
    picks[0] = 4;
    picks[1] = 7;
    const m = marks(tr, picks, 35, A, STEP);
    expect(m[0]).toBe("hit");
    expect(m[1]).toBe("pending");
    expect(m[2]).toBe("pending");
    const late = marks(tr, picks, 60, A, STEP);
    expect(late[0]).toBe("hit");
    expect(late[1]).toBe("miss");
    expect(late[2]).toBe("none");
    expect(hitCount(late)).toBe(1);
  });
  it("hides an opponent's unrevealed columns", () => {
    const tr = record(newTrack(), 0, A);
    const picks = Array.from({ length: 12 }, () => NO_PICK);
    expect(marks(tr, picks, 10, A, STEP, true)[3]).toBe("hidden");
    expect(marks(tr, picks, 10, A, STEP, false)[3]).toBe("pending");
  });
  it("counts a run of hits", () => {
    expect(runEndingAt(["hit", "hit", "miss", "hit", "hit", "hit"], 5)).toBe(3);
    expect(runEndingAt(["hit", "hit", "miss"], 2)).toBe(0);
  });
});
