import type { GameId } from "@/lib/mock";
import type { QueueSeats } from "./useQueue";

/**
 * The Game the hero opens on: the first (in slide order) with someone else waiting in its Queue, Block Puzzle
 * when no Queue has anyone (it is playable before pairing), null while the Queue is still loading.
 */
export function firstSlideGame(queue: QueueSeats | null, order: readonly GameId[], me?: string): GameId | null {
  if (!queue) return null;
  return order.find((g) => queue[g].some((s) => s.player !== me)) ?? "block-puzzle";
}
