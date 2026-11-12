import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RailcarShowcase, SHOWCASE_CRASH_MS, SHOWCASE_MS, showcaseAt, showcaseMoment, showcaseStep } from "./showcase";
import { tellsUpTo } from "./tell-state";

describe("the Railcar showcase (a short ride that plays itself)", () => {
  it("is 12 to 15 seconds long, ending in the Result after the crash", () => {
    expect(SHOWCASE_MS).toBeGreaterThanOrEqual(12_000);
    expect(SHOWCASE_MS).toBeLessThanOrEqual(15_000);
    expect(showcaseAt(SHOWCASE_CRASH_MS - 1).view.phase).toBe("ride");
    expect(showcaseAt(SHOWCASE_CRASH_MS).view.phase).toBe("result");
  });

  it("departs and speeds up, then fires Screws, Panel and Sparks a few seconds apart", () => {
    expect(showcaseAt(0).view).toMatchObject({ phase: "ride", tells: tellsUpTo(0), clockMs: 0 });
    const clock = (ms: number) => (showcaseAt(ms).view as { clockMs: number }).clockMs;
    expect(clock(6_000)).toBeGreaterThan(clock(2_000));
    const firstAt = (n: number) => {
      for (let ms = 0; ms < SHOWCASE_CRASH_MS; ms += 100) if ((showcaseMoment(ms)?.tell ?? 0) >= n) return ms;
      return -1;
    };
    const [s, p, k] = [1, 2, 3].map(firstAt);
    for (const [n, ms] of [[1, s], [2, p], [3, k]]) {
      expect(showcaseAt(ms).view).toMatchObject({ phase: "ride", tells: tellsUpTo(n) });
      expect(showcaseAt(ms - 100).view).toMatchObject({ tells: tellsUpTo(n - 1) });
    }
    expect(s).toBeGreaterThan(0);
    expect(p - s).toBeGreaterThanOrEqual(2_000);
    expect(k - p).toBeGreaterThanOrEqual(2_000);
    expect(SHOWCASE_CRASH_MS - k).toBeGreaterThanOrEqual(2_000);
  });

  it("the Player's Brake is pressed once, halves the car for 5 s, then is used", () => {
    const brakes = Array.from({ length: SHOWCASE_MS / 100 }, (_, i) => showcaseMoment(i * 100)?.brake.status ?? null);
    expect(brakes[0]).toBe("ready");
    expect(showcaseAt(0).brake?.status).toBe("ready");
    const on = brakes.filter((b) => b === "on").length * 100;
    expect(on).toBe(5_000);
    expect(brakes.indexOf("used")).toBeGreaterThan(brakes.lastIndexOf("on") - 1);
    expect(showcaseAt(SHOWCASE_CRASH_MS).brake).toBeNull();
  });

  it("the clock runs on and stops at the Result; Replay starts again from the departure", () => {
    expect(showcaseStep(0, 100)).toBe(100);
    expect(showcaseStep(SHOWCASE_MS - 50, 100)).toBe(SHOWCASE_MS);
    expect(showcaseStep(SHOWCASE_MS, 100)).toBe(SHOWCASE_MS);
    expect(showcaseAt(SHOWCASE_MS).view.phase).toBe("result");
  });

  it("renders the real screen with a Replay button, at the departure", () => {
    const h = renderToStaticMarkup(<RailcarShowcase />);
    expect(h).toContain("Replay");
    expect(h).toContain("rc-stage");
    expect(h).toContain('role="timer"');
  });
});
