/**
 * The accounts each Game keeps for one Match, derived from the address of the tesoro_core Match
 * (`["match", opener, n]`): the Game programs seed them with that address, not with a number.
 * Reads use these; the instruction builders of the Game clients derive the same PDAs.
 */
import { PublicKey } from "@solana/web3.js";

const BLOCK_PUZZLE = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
const HOLDEM = new PublicKey("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");
const TRADING_DUEL = new PublicKey("CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj");
const VANGUARD = new PublicKey("TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH");

const pda = (program: PublicKey, ...seeds: (string | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
    program,
  )[0];

/** Block Burst's Session (open_session seeds ["session", match_state]). */
export const sessionOf = (match: PublicKey) => pda(BLOCK_PUZZLE, "session", match);
/** Hold'em's table (create_match seeds ["match", tesoro_match]). */
export const holdemTableOf = (match: PublicKey) => pda(HOLDEM, "match", match);
/** Trading Duel's Duel (["duel", tesoro_match]). */
export const duelOf = (match: PublicKey) => pda(TRADING_DUEL, "duel", match);
/** Vanguard's Battle (["battle", tesoro_match]). */
export const battleOf = (match: PublicKey) => pda(VANGUARD, "battle", match);
