import type { GuideEnd } from "./HowToPlay";

/** The step an arrow key or swipe leads to; stays put at either end and for any other key. */
export function stepAfterKey(key: string, i: number, count: number): number {
  if (key === "ArrowRight") return Math.min(count - 1, i + 1);
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  return i;
}

/** The last step's buttons, before Back: Practice free is a link only when the page gave one. */
export function lastStepButtons(end: GuideEnd): string[] {
  if (end === "game-page") return ["Practice free", "Done"];
  return [end === "first-practice" ? "Start practice" : "Done"];
}
