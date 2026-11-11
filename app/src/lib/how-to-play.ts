import { GAME_NAMES } from "./mock/data";
import type { GameId } from "./mock/types";

/** A Game with a guide: the four head-to-head Games and Railcar. */
export type GuideGame = GameId | "railcar";

export const guideGameName = (g: GuideGame): string => (g === "railcar" ? "Railcar" : GAME_NAMES[g]);

export interface GuideStep {
  title: string;
  line: string;
}

/** The approved guide: five steps per Game (spec .scratch/how-to-play/spec.md). */
export const GUIDE_STEPS: Record<GuideGame, readonly GuideStep[]> = {
  "block-puzzle": [
    { title: "Same pieces, same time", line: "After the countdown you and your opponent get the same pieces." },
    { title: "Drag pieces onto the board", line: "Place each piece anywhere it fits." },
    { title: "Fill a line to clear it", line: "Full rows and columns burst; clearing several at once scores more." },
    { title: "Watch the scores", line: "Both scores show live, then hide for the last 10 seconds." },
    { title: "Higher score wins", line: "When the 90 seconds are up, the higher score wins." },
  ],
  holdem: [
    { title: "1,500 Chips each", line: "Heads-up, and the blinds rise every hand." },
    { title: "Two cards for you, five to share", line: "Your cards stay hidden from your opponent." },
    { title: "30 seconds to act", line: "Fold, Call, Raise or All-in." },
    { title: "Best five cards win the hand", line: "Make your best five from your two cards and the board." },
    { title: "Last stack standing wins", line: "Win all of your opponent's Chips to win." },
  ],
  "trading-duel": [
    { title: "A live price", line: "12 columns of 10 seconds, after a 30-second head start." },
    { title: "Pick one box per column", line: "Guess where the price line will pass." },
    { title: "Picks stay hidden", line: "Your opponent sees them only when each column locks." },
    { title: "The line hits your box", line: "That scores 100 points." },
    { title: "More points wins", line: "After the last column, the higher score wins." },
  ],
  vanguard: [
    { title: "Your army is placed for you", line: "20 pieces, and the enemy can't see your ranks." },
    { title: "10 seconds a move", line: "Three missed turns and you lose." },
    { title: "Attack to reveal", line: "Move onto an enemy piece. The higher rank wins, and both faces turn up." },
    { title: "Every rank has a power", line: "Select a piece to see what it can do, then tap a square or its power." },
    { title: "Capture the Supply Truck", line: "Take the enemy's Supply Truck to win." },
  ],
  railcar: [
    { title: "One car, one hidden wall", line: "Up to 100 Players ride together toward a wall nobody can see." },
    { title: "Watch for the Tells", line: "Screws, a panel, sparks: each means the wall is closer, and any of them can be the last warning." },
    { title: "Jump to get off", line: "Tap Jump any time. Anyone still aboard when the car hits the wall loses." },
    { title: "One secret Brake", line: "It slows the car for 5 seconds, and only you see it." },
    { title: "Be one of the last three off", line: "The last three Players to Jump before the wall win." },
  ],
};

export type ClipSet = "phone" | "desktop";
export const CLIP_EXTENSIONS = ["webm", "mp4", "webp"] as const;

/** Where step `n` (1-based) of a Game's guide keeps its clip: video as webm and mp4, and a webp poster. */
export function clipPaths(game: GuideGame, n: number, set: ClipSet): { webm: string; mp4: string; poster: string } {
  const base = `/art/how-to-play/${game}/${n}-${set}`;
  return { webm: `${base}.webm`, mp4: `${base}.mp4`, poster: `${base}.webp` };
}
