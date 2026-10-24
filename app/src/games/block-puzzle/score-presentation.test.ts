import { afterEach, describe, expect, it, vi } from "vitest";
import { createScorePresentation } from "./score-presentation";
afterEach(() => vi.useRealTimers());
describe("score receipts", () => {
  it("credits placed cells immediately while only the clear bonus remains pending", () => {
    vi.useFakeTimers(); const seen: number[] = [];
    const score = createScorePresentation((n) => seen.push(n));
    score.award(4, 0, 1); score.award(10, 780, 2);
    expect(seen).toEqual([4]);
    score.award(3, 0, 1);
    expect(seen).toEqual([4, 7]);
    vi.advanceTimersByTime(780);
    expect(seen).toEqual([4, 7, 17]);
  });
  it("credits overlapping rewards once even when a later placement arrives first", () => {
    vi.useFakeTimers(); const seen: number[] = [];
    const score = createScorePresentation((n) => seen.push(n));
    score.award(82, 780, 2); score.award(3, 260, 1);
    vi.advanceTimersByTime(260); expect(seen).toEqual([3]);
    vi.advanceTimersByTime(520); expect(seen).toEqual([3, 85]);
    vi.runAllTimers(); expect(seen).toEqual([3, 85]);
  });
  it("settles to the authoritative final score and cannot credit stale receipts after replay", () => {
    vi.useFakeTimers(); const seen: number[] = [];
    const score = createScorePresentation((n) => seen.push(n));
    score.award(82, 780, 2); score.settle(82);
    score.reset(); score.award(5, 260, 1);
    vi.runAllTimers(); expect(seen).toEqual([82, 0, 5]);
  });
  it("cancels receipts on unmount and handles reduced-motion immediate awards", () => {
    vi.useFakeTimers(); const receive = vi.fn(); const score = createScorePresentation(receive);
    score.award(10, 0, 1); expect(receive).toHaveBeenLastCalledWith(10, 1);
    score.award(20, 780, 2); score.dispose(); vi.runAllTimers(); expect(receive).toHaveBeenCalledTimes(1);
  });
});
