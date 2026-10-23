import type { State } from "./engine";
import { engineStateOf, rebuildRun, type OwnBoard } from "./live-chain";

/**
 * The engine state to resume a run in after a reload: the Seed and the move log, replayed with the same engine the program
 * runs. A Board that has not moved yet resumes from its stored state. The replay must agree with the Board's own score and
 * move count, or the log is not the run the chain holds and nothing is resumed.
 */
export function resumeState(board: OwnBoard): State {
  if (board.moves === 0) return engineStateOf(board);
  const replay = rebuildRun(board.seed, board.log, board.moves);
  if (replay.score !== board.score || replay.moves !== board.moves) throw new Error("The move log does not replay to this Board.");
  return replay;
}
