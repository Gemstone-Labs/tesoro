import { describe, expect, it } from "vitest";
import { MATCH_SECS, NO_PICK, newTrack, record } from "./grid";
import { bandUnits, bandWindow, cameraAfterZoom, cameraX, clampCamera, clampCols, clampU, followU, halfBands, hitCount, layerOffset, layoutFor, marks, maxCamera, maxCols, offscreen, priceDigits, revealU, runEndingAt, snakeWindow, xOf, yOf, yOfUnits } from "./gridView";

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
  it("starts at the anchor, drops samples from before the start and from after the end", () => {
    const r = snakeWindow(
      [
        { t: 500, p: 99 },
        { t: 3000, p: 100.1 },
        { t: 4000, p: 100.3 },
        { t: 1000 + (MATCH_SECS + 5) * 1000, p: 120 },
      ],
      1000,
      100,
      l,
      0.25,
    );
    expect(r.p).toBe(100.3);
    expect(r.x).toBeCloseTo(xOf(3, l.cw));
    expect(r.d.match(/Q/g)).toHaveLength(1);
  });
  it("draws the line wherever the price is, up is negative y", () => {
    expect(yOf(100, 100, 0.25, l.rh)).toBeCloseTo(0);
    expect(yOf(100.5, 100, 0.25, l.rh)).toBeCloseTo(-2 * l.rh);
    expect(yOf(99.5, 100, 0.25, l.rh)).toBeCloseTo(2 * l.rh);
    expect(yOf(1100, 100, 0.25, l.rh)).toBeCloseTo(-4000 * l.rh);
  });
  it("draws one path and reports its end", () => {
    const p = snakeWindow([{ t: 1000, p: 100.1 }], 0, 100, l, 0.25);
    expect(p.d.startsWith("M")).toBe(true);
    expect(p.x).toBeCloseTo(xOf(1, l.cw), 0);
  });
  it("draws just the window of a dense series, and thins points a pixel apart", () => {
    const series = Array.from({ length: 3000 }, (_, i) => ({ t: 1 + i * 50, p: 100 + Math.sin(i / 7) * 0.2 }));
    const all = snakeWindow(series, 0, 100, l, 0.25);
    const part = snakeWindow(series, 0, 100, l, 0.25, xOf(60, l.cw), xOf(80, l.cw));
    expect(part.d.length).toBeLessThan(all.d.length / 3);
    expect(part.d.startsWith("M")).toBe(true);
    expect(part.x).toBe(all.x);
    expect(all.d.match(/Q/g)!.length).toBeLessThan(3000);
  });
  it("prints enough decimals", () => {
    expect([priceDigits(0.6), priceDigits(0.035), priceDigits(0.0108), priceDigits(0.004)]).toEqual([2, 3, 3, 4]);
  });
});

describe("marks", () => {
  it("hits as soon as the line touches, misses only once the column is done", () => {
    let tr = record(newTrack(), 0, A);
    tr = record(tr, 31, A); // column 0, band 0
    const picks = Array.from({ length: 12 }, () => NO_PICK);
    picks[0] = 0;
    picks[1] = 3;
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

describe("zoom", () => {
  it("shows 3 to 12 columns, fewer at the wide end on a phone", () => {
    expect(layoutFor(1000, 3).cw).toBeCloseTo(1000 / 3);
    expect(layoutFor(1000, 99).cw).toBeCloseTo(1000 / 12);
    expect(layoutFor(1000, 1).cw).toBeCloseTo(1000 / 3);
    expect(maxCols(316)).toBe(7);
    expect(clampCols(12, 316)).toBe(7);
    expect(layoutFor(1000).cw).toBeCloseTo(1000 / 7.6);
  });
  it("scales bands with the columns, within tappable limits, and the view height never changes", () => {
    const wide = layoutFor(1200);
    expect(layoutFor(1200, 12).rh).toBeLessThan(wide.rh);
    expect(layoutFor(1200, 3).rh).toBeGreaterThan(wide.rh);
    expect(layoutFor(1200, 3).rh).toBeLessThanOrEqual(Math.round(70 * 1.6));
    expect(layoutFor(1200, 12).rh).toBeGreaterThanOrEqual(30);
    for (const n of [3, 5, 8, 12]) expect(layoutFor(1200, n).bodyH).toBe(6 * 70);
    const phone = layoutFor(390 - 74);
    expect(phone.rh).toBe(56);
    expect(layoutFor(316, maxCols(316)).rh).toBe(44);
    expect(halfBands(phone) * 2).toBeCloseTo(6);
    expect(halfBands(layoutFor(1200, 12)) * 2).toBeGreaterThan(9);
  });
  it("keeps the time under the anchor where it was", () => {
    const a = layoutFor(1000, 6);
    const b = layoutFor(1000, 3);
    const cam = 400;
    const secsAt = (c: number, l: typeof a, f: number) => ((c + l.viewW * f) / l.cw) * 10;
    for (const f of [0, 0.5, 1]) {
      const next = cameraAfterZoom(cam, a, b, f);
      if (next > 0 && next < maxCamera(b)) expect(secsAt(next, b, f)).toBeCloseTo(secsAt(cam, a, f));
    }
  });
  it("keeps a panned camera inside the world", () => {
    const l = layoutFor(1000);
    expect(clampCamera(-50, l)).toBe(0);
    expect(clampCamera(1e9, l)).toBe(maxCamera(l));
    expect(maxCamera(l)).toBeCloseTo(15 * l.cw - 1000);
  });
});

describe("vertical camera", () => {
  const l = layoutFor(1000);
  it("measures prices in bands from the start price, negative below", () => {
    expect(bandUnits(100, 100, 0.25)).toBe(0);
    expect(bandUnits(99.75, 100, 0.25)).toBe(-1);
    expect(bandUnits(110, 100, 0.25)).toBe(40);
    expect(bandUnits(1e12, 100, 0.25)).toBeLessThan(40000);
    expect(yOfUnits(3, 50)).toBe(-150);
  });
  it("puts the camera's band in the middle of the view", () => {
    expect(layerOffset(0, l)).toBe(l.bodyH / 2);
    expect(layerOffset(40, l)).toBe(l.bodyH / 2 + 40 * l.rh);
    expect(yOfUnits(40, l.rh) + layerOffset(40, l)).toBeCloseTo(l.bodyH / 2);
  });
  it("follows a far-away price: eases toward it and never lets the head leave the view", () => {
    let u: number | null = null;
    u = followU(u, 40, 0.016, l);
    expect(u).toBe(40);
    for (let i = 0; i < 20; i++) u = followU(u, 40 + i * 5, 0.016, l);
    const head = 40 + 19 * 5;
    expect(Math.abs(head - u)).toBeLessThanOrEqual(halfBands(l) - 1.5 + 1e-9);
    let v = followU(40, 40, 0.016, l);
    for (let i = 0; i < 400; i++) v = followU(v, 41.3, 0.016, l);
    expect(v).toBeCloseTo(41.3, 2);
  });
  it("steps whole bands under reduced motion, and clamps negatives", () => {
    expect(followU(0, 12.4, 1, l, true)).toBe(12);
    expect(followU(0, -7.6, 1, l, true)).toBe(-8);
    expect(clampU(-1e9)).toBe(-32767);
  });
  it("renders a window of bands around the camera in steps of four", () => {
    const w = bandWindow(40.3, l);
    expect(w.lo % 4).toBe(0);
    expect(w.lo).toBeLessThan(40.3 - halfBands(l));
    expect(w.hi).toBeGreaterThan(40.3 + halfBands(l));
    expect(bandWindow(41, l)).toEqual(bandWindow(40.3, l));
    const neg = bandWindow(-33.2, l);
    expect(neg.lo).toBeLessThan(-33.2 - halfBands(l));
  });
  it("tells which picks are out of view, above or below", () => {
    const h = halfBands(l);
    expect(offscreen(0, 0, l)).toBe(0);
    expect(offscreen(Math.ceil(h) + 1, 0, l)).toBe(1);
    expect(offscreen(-Math.ceil(h) - 2, 0, l)).toBe(-1);
    expect(offscreen(Math.floor(h) - 1, 0, l)).toBe(0);
    expect(offscreen(-Math.floor(h), 0, l)).toBe(0);
    // a sliver at the edge is not enough to tap
    expect(offscreen(h - 0.2, 0, l)).toBe(1);
    expect(offscreen(h - 0.6, 0, l)).toBe(0);
    expect(offscreen(-h - 0.8, 0, l)).toBe(-1);
    expect(offscreen(-h - 0.4, 0, l)).toBe(0);
  });
  it("scrolls the least that brings a band into view", () => {
    const h = halfBands(l);
    expect(revealU(0, 0, l)).toBe(0);
    expect(revealU(20, 0, l)).toBeCloseTo(21 - h);
    expect(offscreen(20, revealU(20, 0, l), l)).toBe(0);
    expect(revealU(-20, 0, l)).toBeCloseTo(-20 + h);
    expect(offscreen(-20, revealU(-20, 0, l), l)).toBe(0);
  });
});

describe("layoutFor fillH", () => {
  it("grows the band area to the height left on a phone, never below the default and at most twice it", () => {
    const base = layoutFor(390).bodyH;
    expect(layoutFor(390, undefined, 520).bodyH).toBe(520);
    expect(layoutFor(390, undefined, 100).bodyH).toBe(base);
    expect(layoutFor(390, undefined, 5000).bodyH).toBe(base * 2);
  });
});
