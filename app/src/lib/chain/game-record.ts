import { PublicKey } from "@solana/web3.js";
import { TESORO_CORE_ID, pda } from "./native";

/** The loader every Game program is deployed through. */
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const s = (v: string) => Buffer.from(v);

/** A Game's record in tesoro_core: `["game", program_id]` (docs/adr/0013). */
export const gameRecordPda = (game: PublicKey) => pda([s("game"), game.toBuffer()]);

/** The program's ProgramData; tesoro_core reads the deploy slot from it to tell whether the Game is listed. */
export const programDataPda = (game: PublicKey) => PublicKey.findProgramAddressSync([game.toBuffer()], UPGRADEABLE_LOADER)[0];

/** The three accounts every `open_match` names for its Game. */
export const gameAccounts = (game: PublicKey) => ({
  gameRecord: gameRecordPda(game),
  gameProgram: game,
  programData: programDataPda(game),
});

/** Matches one opener-to-joiner pair has started today: `["pair", opener Account, joiner Account]`. */
export const pairPda = (openerAccount: PublicKey, joinerAccount: PublicKey) => pda([s("pair"), openerAccount.toBuffer(), joinerAccount.toBuffer()], TESORO_CORE_ID);

/** The PDA an immutable Game program signs with to register or change itself. */
export const registerPda = (game: PublicKey) => PublicKey.findProgramAddressSync([s("tesoro-register")], game)[0];
