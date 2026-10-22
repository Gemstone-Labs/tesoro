import type { Rpc } from "./rpc";

/**
 * The public end state of a finished table Match, as the keeper stores it (migration 0011). Every field is public at Match end;
 * hidden seat data (Hold'em hole cards that were not shown, a Player's unlocked picks) never goes in. JSON only: no bigint, no bytes.
 */
export type EndState =
  | {
      game: "trading-duel";
      /** The 24 columns' price range, as decimal strings (the price units of the Duel). */
      track: { lo: string[]; hi: string[]; seen: boolean[] };
      /** Each seat's 24 picks (255 = none). */
      picks: [number[], number[]];
      scores: [number, number];
      winner: number;
    }
  | {
      game: "holdem";
      handNo: number;
      /** 0/1 = winning seat, 2 = chop. */
      result: number;
      pot: string;
      board: number[];
      /** Both hands, only when the hand went to showdown; null when someone folded. */
      shown: [[number, number], [number, number]] | null;
      stacks: [string, string];
      winner: number;
    }
  | {
      game: "block-puzzle";
      scores: [number, number];
      moves: [number, number];
      reason: number;
      /** Public once the Match is closed; null where the log was not kept. */
      log: { seed: string; seedHash: string; startSlot: number; moves: string; offsets: string } | null;
    };

export interface StoredEndState {
  game: string;
  epoch: number;
  state: EndState;
}

/** The captured end state of a Match, or null when none exists. */
export async function endStateOf(rpc: Rpc, matchAddress: string): Promise<StoredEndState | null> {
  return (await rpc("end_state_of", { p_match: matchAddress })) as StoredEndState | null;
}

/** Stores an end state once. Returns whether this call stored it. */
export async function recordEndState(rpc: Rpc, matchAddress: string, epoch: number, state: EndState): Promise<boolean> {
  return (await rpc("record_end_state", { p: { match_address: matchAddress, game: state.game, epoch, state } })) as boolean;
}
