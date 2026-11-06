import type { GameId } from "./mock/types";

export interface GuideStep {
  title: string;
  line: string;
}

/** The approved guide: five steps per Game (spec .scratch/how-to-play/spec.md). */
export const GUIDE_STEPS: Record<GameId, readonly GuideStep[]> = {
  "block-puzzle": [
    { title: "Same pieces, same time", line: "After the countdown you and your opponent get the same pieces." },
    { title: "Drag pieces onto the board", line: "Place each piece anywhere it fits." },
    { title: "Fill a line to clear it", line: "Full rows and columns burst; clearing several at once scores more." },
    { title: "Watch the scores", line: "Both scores show live, then hide for the last 10 seconds." },
    { title: "Higher score wins", line: "After 90 seconds the higher score takes the Pot minus Fees." },
  ],
  holdem: [
    { title: "1,500 Chips each", line: "Heads-up, and the blinds rise every hand." },
    { title: "Two cards for you, five to share", line: "Your cards stay hidden from your opponent." },
    { title: "30 seconds to act", line: "Fold, Call, Raise or All-in." },
    { title: "Best five cards win the hand", line: "Make your best five from your two cards and the board." },
    { title: "Last stack standing wins", line: "The winner takes the Pot minus Fees." },
  ],
  "trading-duel": [
    { title: "A live price", line: "12 columns of 10 seconds, after a 30-second head start." },
    { title: "Pick one box per column", line: "Guess where the price line will pass." },
    { title: "Picks stay hidden", line: "Your opponent sees them only when each column locks." },
    { title: "The line hits your box", line: "That scores 100 points." },
    { title: "More points wins", line: "The winner takes the Pot minus Fees; a tie refunds both." },
  ],
  vanguard: [
    { title: "Your army is placed for you", line: "20 pieces, and the enemy can't see your ranks." },
    { title: "10 seconds a move", line: "Three missed turns and you lose." },
    { title: "Attack to reveal", line: "The higher rank wins; the Spy beats the General of the Army; Landmines beat every attacker." },
    { title: "Every rank has a power", line: "Tap a piece to use it; Ranks and powers lists them all." },
    { title: "Capture the Supply Truck", line: "It wins the Pot minus Fees; a draw refunds both." },
  ],
};

export type ClipSet = "phone" | "desktop";
export const CLIP_EXTENSIONS = ["webm", "mp4", "webp"] as const;

/** Where step `n` (1-based) of a Game's guide keeps its clip: video as webm and mp4, and a webp poster. */
export function clipPaths(game: GameId, n: number, set: ClipSet): { webm: string; mp4: string; poster: string } {
  const base = `/art/how-to-play/${game}/${n}-${set}`;
  return { webm: `${base}.webm`, mp4: `${base}.mp4`, poster: `${base}.webp` };
}
