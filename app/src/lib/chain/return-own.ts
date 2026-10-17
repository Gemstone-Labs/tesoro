import "./polyfill";
import { BN } from "@coral-xyz/anchor";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { returnableGemas } from "./ledger";
import { holdingPda, returnOwnRemaining } from "./native";
import type { ChainHolding } from "./read";

/** One Source of `position` the Account can return Gemas to, with the most it can return. */
export interface ReturnRow {
  holding: ChainHolding;
  max: bigint;
}

/** The Account's returnable Gemas on one Position, per Source (native and ETH alike). */
export function returnRows(holdings: ChainHolding[], position: PublicKey, account: PublicKey): ReturnRow[] {
  const me = account.toBase58();
  return holdings
    .filter((h) => h.position.equals(position))
    .map((h) => ({ holding: h, max: returnableGemas(h, me) }))
    .filter((r) => r.max > 0n);
}

/** `return_own` from the generated tesoro_core client: cancels `amount` Gemas of the owner's Debt on one Source. A native Position also needs the sim_lst pool (its Debt is computed from the clock). */
export async function returnOwnIx(owner: PublicKey, position: PublicKey, source: PublicKey, amount: bigint, native = false): Promise<TransactionInstruction> {
  const ownerAccount = BlockPuzzleChain.coreAccount(owner);
  return getChain()
    .core.methods.returnOwn(new BN(amount.toString()))
    .accountsPartial({ ownerAuthority: owner, ownerAccount, position, source, holding: holdingPda(ownerAccount, source) })
    .remainingAccounts(native ? returnOwnRemaining() : [])
    .instruction();
}

export async function returnOwn(signer: ChainSigner, position: PublicKey, source: PublicKey, amount: bigint, native = false): Promise<string> {
  return getChain().sendBase(signer, [await returnOwnIx(signer.publicKey, position, source, amount, native)]);
}
