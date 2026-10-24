import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { basketPda, spillPda } from "@/lib/chain/basket";
import { coreIx } from "@/lib/chain/core-ix";

type StoreReader = { getMultipleAccountsInfo(keys: PublicKey[]): Promise<(object | null)[]> };

/** Legacy Accounts have neither store. Initialize them in the oracle-paid Advance transaction before it credits Gemas. */
export async function advanceSetup(conn: StoreReader, payer: PublicKey, account: PublicKey): Promise<TransactionInstruction[]> {
  const basket = basketPda(account), spill = spillPda(account);
  const [b, s] = await conn.getMultipleAccountsInfo([basket, spill]);
  if (b && s) return [];
  if (b || s) throw new Error("The Account's Gemas stores are incomplete.");
  return [coreIx("init_stores", { payer, account, basket, spill })];
}
