import type { PublicKey } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../games/block-puzzle/chain";
import { HOLDEM_PROGRAM_ID } from "../../games/holdem/chain";
import { TRADING_DUEL_PROGRAM_ID } from "../../games/trading-duel/chain";
import { VANGUARD_PROGRAM_ID } from "../../games/vanguard/chain";
import type { GameId } from "../mock/types";

/** The program id a Match of each Game is opened with. The one place a Game is tied to its program; the app and the keeper both read it. */
export const GAME_IDS: Record<GameId, PublicKey> = {
  "block-puzzle": BLOCK_PUZZLE_PROGRAM_ID,
  holdem: HOLDEM_PROGRAM_ID,
  "trading-duel": TRADING_DUEL_PROGRAM_ID,
  vanguard: VANGUARD_PROGRAM_ID,
};

/** The Game a program id belongs to; null for a program this app does not play. */
export const gameOfProgram = (program: PublicKey): GameId | null => (Object.keys(GAME_IDS) as GameId[]).find((g) => GAME_IDS[g].equals(program)) ?? null;
