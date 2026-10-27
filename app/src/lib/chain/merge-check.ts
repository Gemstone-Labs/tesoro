import { canMove, type Merged } from "./queue";
import type { ChainMatch } from "./read";

export interface QueueMerge {
  /** "moving": the refund and join are under way; "failed": the move stopped half way (see `error`). */
  phase: "idle" | "moving" | "failed";
  error: string | null;
}

export interface MergeIo {
  /** Fresh read of the Match this page shows. */
  fetchMine(): Promise<ChainMatch | null>;
  merge(mine: ChainMatch): Promise<Merged>;
  set(s: QueueMerge): void;
  /** Goes to the Match the Player now sits in. Only called while the Player is still on this page. */
  navigate(id: string): void;
  /** Whether the Player is still on the page of the Match that was checked. */
  stillHere(): boolean;
}

/**
 * One look for an older Match from the waiting page. Nothing happens unless the Player is alone in an unbacked Queue Match.
 * While the move runs the page shows "moving" (so the refund of the abandoned Match never flashes up as its own screen); a
 * move that finds nothing leaves the page as it was, and one that stops half way says so.
 */
export async function checkForOlder(io: MergeIo): Promise<void> {
  try {
    const mine = await io.fetchMine();
    if (!mine || !canMove(mine)) return;
    io.set({ phase: "moving", error: null });
    const merged = await io.merge(mine);
    if (!merged.moved) io.set({ phase: "idle", error: null });
    else if (io.stillHere()) io.navigate(merged.entered.id);
  } catch (e) {
    io.set({ phase: "failed", error: e instanceof Error ? e.message : "Something went wrong while moving you to an older Match." });
  }
}
