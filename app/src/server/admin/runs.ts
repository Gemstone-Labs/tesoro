import { boardTiming, batchOffsets } from "@/games/block-puzzle/move-timing";
import { offsetsOf } from "@/games/block-puzzle/live-chain";
import type { EndState } from "@/server/history/end-state";
import type { RunBatches } from "@/lib/review/flags";

type BurstEnd = Extract<EndState, { game: "block-puzzle" }>;

/**
 * The batch cadence of both runs of a finished Block Burst Match, from the end state the keeper stored (ticket 33) and the
 * Match's two Accounts (side 0 first). A Match with no kept log, or one side that never moved, gives nothing for that side.
 */
export function runsFromEndState(matchId: string, accounts: readonly string[], end: EndState): RunBatches[] {
  if (end.game !== "block-puzzle") return [];
  const burst: BurstEnd = end;
  if (!burst.log) return [];
  const offsets = Buffer.from(burst.log.offsets, "hex");
  const out: RunBatches[] = [];
  for (const seat of [0, 1] as const) {
    const moves = burst.moves[seat];
    const account = accounts[seat];
    if (!account || moves <= 0) continue;
    const slots = offsetsOf(offsets, seat, moves);
    const batches = batchOffsets(boardTiming({ startSlot: burst.log.startSlot, moves, moveSlots: slots }));
    out.push({ matchId, account, batches });
  }
  return out;
}
