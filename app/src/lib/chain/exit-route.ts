import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { coreIxName } from "./core-ix";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TESORO_CORE_ID } from "./native";

/** The Player's own exits that may carry setup (their token account, checkpoint pages) paid by the relayer. */
const PREPARED_EXITS = ["redeem", "request_instant_redeem", "unlock"];

export type ExitRoute =
  /** Every instruction is a core one the relayer signs for as it is. */
  | { kind: "free"; feePayer: PublicKey; ixs: TransactionInstruction[] }
  /** Setup (token account, checkpoint pages) first, then one exit: the relayer pays the setup's rent as `ixs` say. */
  | { kind: "prepared"; feePayer: PublicKey; ixs: TransactionInstruction[] }
  /** The Player pays the fee and any rent. */
  | { kind: "self-pay"; feePayer: PublicKey; ixs: TransactionInstruction[] };

/**
 * The one rule for how an exit is sent and who pays its fee. `exitSend` sends what this returns and the Unlock dry run
 * simulates the same instructions with the same fee payer, so a Player with no SOL is never simulated as the payer of
 * something the relayer will carry.
 */
export function planExit(ixs: readonly TransactionInstruction[], player: PublicKey, relayer: PublicKey): ExitRoute {
  const setup = (ix: TransactionInstruction) => coreIxName(ix) === "init_ckpt_page" || ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
  const prefix = ixs.slice(0, -1);
  const prepared = prefix.length > 0 && PREPARED_EXITS.includes(coreIxName(ixs.at(-1)!) ?? "") && prefix.every(setup);
  if (prepared) {
    const rewritten = ixs.map((ix, i) => i === ixs.length - 1 ? ix : new TransactionInstruction({
      programId: ix.programId, data: ix.data,
      keys: ix.keys.map((k, j) => j === 0 ? { ...k, pubkey: relayer } : k),
    }));
    return { kind: "prepared", feePayer: relayer, ixs: rewritten };
  }
  if (ixs.every((ix) => ix.programId.equals(TESORO_CORE_ID) && coreIxName(ix) !== "init_ckpt_page")) return { kind: "free", feePayer: relayer, ixs: [...ixs] };
  return { kind: "self-pay", feePayer: player, ixs: [...ixs] };
}
