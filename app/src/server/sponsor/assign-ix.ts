import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { GAME_IDS } from "@/lib/chain/games";
import type { GameId } from "@/lib/mock/types";
import { CORE_ID } from "./rules";

/** Anchor's discriminator of `assign_match`, the same in every Game. */
const ASSIGN_MATCH = Buffer.from([195, 128, 179, 141, 148, 120, 135, 51]);

/** Games the server assigns. Trading Duel's `assign_match` also checks the Match's asset; the caller refuses an unknown one first (`assignJoin`). */
const ASSIGNABLE: Partial<Record<GameId, { config: string }>> = {
  "block-puzzle": { config: "config" },
  holdem: { config: "config" },
  "trading-duel": { config: "config" },
  vanguard: { config: "tables" },
};

export const canAssign = (game: GameId): boolean => game in ASSIGNABLE;

export interface TablePick {
  generation: number;
  index: number;
  epoch: bigint;
}

/**
 * The Game's `assign_match`: the operator binds `match` to one table at its current epoch, once. The two Accounts are the
 * Match's Players' tesoro_core Accounts. All four Games lay the instruction out the same; Vanguard's table settings live
 * under the `tables` seed instead of `config`.
 */
export function assignMatchIx(game: GameId, a: { operator: PublicKey; match: PublicKey; accountA: PublicKey; accountB: PublicKey; pick: TablePick }): TransactionInstruction {
  const spec = ASSIGNABLE[game];
  if (!spec) throw new Error(`assign_match is not built for ${game}`);
  const program = GAME_IDS[game];
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const data = Buffer.alloc(20);
  ASSIGN_MATCH.copy(data, 0);
  data.writeUInt16LE(a.pick.generation, 8);
  data.writeUInt16LE(a.pick.index, 10);
  data.writeBigUInt64LE(a.pick.epoch, 12);
  const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: program,
    keys: [
      meta(a.operator, true, true),
      meta(pda(Buffer.from(spec.config))),
      meta(a.match, false, true),
      meta(a.accountA),
      meta(a.accountB),
      meta(pda(Buffer.from("authority"))),
      meta(pda(Buffer.from("assign"), a.match.toBuffer()), false, true),
      meta(CORE_ID),
      meta(SystemProgram.programId),
    ],
    data,
  });
}
