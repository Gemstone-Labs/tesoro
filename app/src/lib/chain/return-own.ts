import "./polyfill";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { accountPda, lineArg, meta, nativeKindAccounts } from "./native";
import { basketPda, spillPda } from "./basket";
import { coreIx } from "./core-ix";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { returnableGemas } from "./ledger";
import type { ChainHolding } from "./read";
import { exitSend, sourceAccounts } from "./redeem";
import { JITOSOL, stakeRateRemaining, stakeTokenOf } from "./stake";

/** One line of `position` the Account can return Gemas to, with the most it can return. */
export interface ReturnRow {
  holding: ChainHolding;
  max: bigint;
}

/** The Account's returnable Gemas on one Position, per line (native and ETH alike). */
export function returnRows(holdings: ChainHolding[], position: PublicKey, account: PublicKey): ReturnRow[] {
  const me = account.toBase58();
  return holdings
    .filter((h) => h.position.equals(position))
    .map((h) => ({ holding: h, max: returnableGemas(h, me) }))
    .filter((r) => r.max > 0n);
}

type Target = Pick<ChainHolding, "line" | "accounts" | "source" | "position" | "native" | "stakeMint">;

/**
 * `return_own`: cancels `amount` Gemas of the owner's Debt on one line. A native or staking-token Position also needs its custody and
 * pool (its Debt is computed), then the Source's book and checkpoint pages; an ETH or HYPE Position needs only the book.
 */
export function returnOwnIx(owner: PublicKey, h: Target, amount: bigint, book: PublicKey[] = h.accounts): TransactionInstruction {
  const account = accountPda(owner);
  const kind = h.stakeMint ? stakeRateRemaining(stakeTokenOf(h.stakeMint) ?? JITOSOL) : h.native ? nativeKindAccounts() : [];
  return coreIx(
    "return_own",
    { owner_authority: owner, owner_account: account, basket: basketPda(account), spill: spillPda(account), position: h.position, source: h.source },
    { line: lineArg(h.line), amount },
    [...kind, ...book.map((k) => meta(k, true))],
  );
}

/** Returns `amount` Gemas of one line to its Position. The relayer's allow-list has no row for it yet, so the Player pays the fee. */
export async function returnOwn(signer: ChainSigner, getToken: GetToken, h: Target, amount: bigint): Promise<string> {
  const { accounts, create } = await sourceAccounts(getChain().base, h.source, h.accounts, signer.publicKey);
  return exitSend(signer, getToken, [...create, returnOwnIx(signer.publicKey, h, amount, accounts)], { sponsor: false });
}
