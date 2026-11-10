import type { GameId } from "./mock/types";

const key = (game: GameId) => `tesoro:how-to-play:${game}`;

/** Games whose guide was opened in this tab: the fallback when storage throws or is blocked. */
const shownInTab = new Set<GameId>();

/** True the first time this device opens Practice for the Game; false once it has (or once this tab has, when storage fails). */
export function shouldShowFirstPracticeGuide(game: GameId): boolean {
  if (shownInTab.has(game)) return false;
  try {
    return window.localStorage.getItem(key(game)) === null;
  } catch {
    return true;
  }
}

export function markFirstPracticeGuideShown(game: GameId): void {
  shownInTab.add(game);
  try {
    window.localStorage.setItem(key(game), "1");
  } catch {
    // the in-tab record above still stops a second showing
  }
}
