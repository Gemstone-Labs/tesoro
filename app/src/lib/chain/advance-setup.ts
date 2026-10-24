import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { basketPda, decodeStore, MAX_STORE_LINES, spillPda } from "./basket";
import { coreIx } from "./core-ix";

type StoreReader = { getMultipleAccountsInfo(keys: PublicKey[]): Promise<({ data: Uint8Array } | null)[]> };

/** Prepare one new Advance line, atomically with its credit. The deposit's payer owns this rent. */
export async function advanceSetup(conn: StoreReader, payer: PublicKey, account: PublicKey): Promise<TransactionInstruction[]> {
  const basket = basketPda(account), spill = spillPda(account);
  const [b, s] = await conn.getMultipleAccountsInfo([basket, spill]);
  if (!b && !s) return [coreIx("init_stores", { payer, account, basket, spill })];
  if (!b || !s) throw new Error("The Account's Gemas stores are incomplete.");
  const bh = decodeStore(b.data).header, sh = decodeStore(s.data).header;
  if (!bh.account.equals(account) || !sh.account.equals(account)) throw new Error("The Account's Gemas stores do not belong to it.");
  const room = bh.capacity - bh.len + Math.max(0, sh.capacity - sh.len - sh.roomReserved);
  if (room > 0) return [];
  const which = bh.capacity < MAX_STORE_LINES ? "Basket" : sh.capacity < MAX_STORE_LINES ? "Spill" : null;
  if (!which) throw new Error("Your Gemas stores are full. Redeem or spend some Gemas before taking another Advance.");
  return [coreIx("grow_store", { payer, account, basket, spill }, { which: { [which]: {} }, extra_lines: 1 })];
}
