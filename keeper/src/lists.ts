import anchor from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";
import { CORE_ID } from "./kit.ts";
import { loadIdl } from "./runtime.ts";

export interface Row {
  pubkey: PublicKey;
  data: Buffer;
}

/** Lists the accounts of tesoro_core of one type (a getProgramAccounts filtered by the type's discriminator). */
export type Lister = (account: string, opts?: { dataSlice?: { offset: number; length: number }; dataSize?: number }) => Promise<Row[]>;

/** The 8-byte discriminator of an account type of tesoro_core (`Name` as in the IDL's `accounts`). */
export function discriminatorOf(name: string): Buffer {
  const hit = (loadIdl("tesoro_core").accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === name);
  if (!hit) throw new Error(`tesoro_core has no account type ${name}`);
  return Buffer.from(hit.discriminator);
}

export const connLister = (conn: Pick<Connection, "getProgramAccounts">): Lister => async (account, opts = {}) => {
  const filters: ({ memcmp: { offset: number; bytes: string } } | { dataSize: number })[] = [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminatorOf(account)) } }];
  if (opts.dataSize) filters.push({ dataSize: opts.dataSize });
  const rows = await conn.getProgramAccounts(CORE_ID, { commitment: "confirmed", filters, dataSlice: opts.dataSlice });
  return rows.map((r) => ({ pubkey: r.pubkey, data: Buffer.from(r.account.data) }));
};
