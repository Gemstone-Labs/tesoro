import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { pollConfirm } from "./runtime.ts";

/** A transaction is at most this many bytes on the wire. */
export const MAX_TX_BYTES = 1232;

type Signer = Pick<Keypair, "publicKey" | "secretKey">;

export interface SendOpts {
  /** Compute unit limit (a ComputeBudget instruction is added when set). */
  units?: number;
  /** Address lookup tables to compile with. */
  tables?: AddressLookupTableAccount[];
  /** Further signers (an authority that is not the fee payer). */
  signers?: Signer[];
}

export function compile(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], opts: SendOpts = {}): VersionedTransaction {
  const all = opts.units ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units }), ...ixs] : ixs;
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToV0Message(opts.tables));
}

/** Serialized size in bytes with every signature, as the network counts it. */
export function wireSize(payer: PublicKey, ixs: TransactionInstruction[], opts: SendOpts = {}): number {
  return compile(payer, PublicKey.default.toBase58(), ixs, opts).serialize().length + 64 * (opts.signers?.length ?? 0);
}

/** A transaction locks at most this many accounts. */
export const MAX_ACCOUNTS = 64;

/** Accounts a compiled transaction names, counting those read through lookup tables. */
export function accountCount(payer: PublicKey, ixs: TransactionInstruction[], opts: SendOpts = {}): number {
  const m = compile(payer, PublicKey.default.toBase58(), ixs, opts).message;
  return m.staticAccountKeys.length + m.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
}

/** True when `ixs` fit one transaction: at most 1,232 bytes and 64 accounts. */
export const fits = (payer: PublicKey, ixs: TransactionInstruction[], opts: SendOpts = {}) => {
  try {
    return wireSize(payer, ixs, opts) <= MAX_TX_BYTES && accountCount(payer, ixs, opts) <= MAX_ACCOUNTS;
  } catch {
    return false;
  }
};

/** The lookup tables named in KEEPER_LOOKUP_TABLES (comma separated), fetched once. */
let tablesCache: { key: string; tables: AddressLookupTableAccount[] } | null = null;
export async function lookupTables(conn: Connection, env: NodeJS.ProcessEnv = process.env): Promise<AddressLookupTableAccount[]> {
  const raw = (env.KEEPER_LOOKUP_TABLES ?? env.TESORO_SPONSOR_LOOKUP_TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return [];
  const key = raw.join(",");
  if (tablesCache?.key === key) return tablesCache.tables;
  const tables: AddressLookupTableAccount[] = [];
  for (const addr of raw) {
    const t = (await conn.getAddressLookupTable(new PublicKey(addr))).value;
    if (t) tables.push(t);
  }
  tablesCache = { key, tables };
  return tables;
}

/** Signs with `payer`, sends and waits for confirmation; throws with the chain's error when the transaction fails. */
export async function sendIxs(conn: Connection, payer: Signer, ixs: TransactionInstruction[], opts: SendOpts = {}): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = compile(payer.publicKey, blockhash, ixs, opts);
  tx.sign([payer, ...(opts.signers ?? [])] as Keypair[]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  const res = await pollConfirm(conn, { signature: sig, lastValidBlockHeight });
  if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}
