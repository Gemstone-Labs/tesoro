import type { GuideEnd } from "./HowToPlay";

/** The step an arrow key or swipe leads to; stays put at either end and for any other key. */
export function stepAfterKey(key: string, i: number, count: number): number {
  if (key === "ArrowRight") return Math.min(count - 1, i + 1);
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  return i;
}

/** The last step's button, beside Back: Start practice before a first Practice, Done everywhere else. */
export function lastStepButton(end: GuideEnd): string {
  return end === "first-practice" ? "Start practice" : "Done";
}
