/**
 * The account Block Burst keeps for one Match, derived from the address of the tesoro_core Match
 * (`["match", opener, n]`). Hold'em, Trading Duel and Vanguard play on persistent tables: a table is
 * not a Match's account, so they have no address here. A table is found through the Match's
 * Assignment (`readAssignment` in each Game's chain client), and a finished Match's winner is in
 * tesoro_core's record (`RunKind::Win`).
 */
import { PublicKey } from "@solana/web3.js";

const BLOCK_PUZZLE = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");

const pda = (program: PublicKey, ...seeds: (string | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
    program,
  )[0];

/** Block Burst's Session (open_session seeds ["session", match_state]). */
export const sessionOf = (match: PublicKey) => pda(BLOCK_PUZZLE, "session", match);
