import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { pollConfirm } from "./runtime.ts";
import { completionEffects, completionInput, recoverCompletions, type CompletionStore } from "../../app/src/server/sponsor/completion.ts";
import { MAX_ACCOUNTS, MAX_TX_BYTES, accountCount, compileTx, fits, wireSize } from "../../app/src/lib/chain/settle-plan.ts";
import { keeperCompletionStore } from "./sponsor-completion.ts";

export { MAX_ACCOUNTS, MAX_TX_BYTES, accountCount, fits, wireSize };

type Signer = Pick<Keypair, "publicKey" | "secretKey">;

export interface SendOpts {
  /** Override the durable journal in tests. Production resolves the shared persistent store from its environment. */
  completion?: CompletionStore | null;
  /** Compute unit limit (a ComputeBudget instruction is added when set). */
  units?: number;
  /** Address lookup tables to compile with. */
  tables?: AddressLookupTableAccount[];
  /** Further signers (an authority that is not the fee payer). */
  signers?: Signer[];
}

export const compile = compileTx;

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
  const effects = completionEffects(ixs);
  const store = effects.closes.length ? (opts.completion === undefined ? keeperCompletionStore() : opts.completion) : null;
  if (store) await store.prepareCompletion(completionInput(tx, effects, 0n));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  const res = await pollConfirm(conn, { signature: sig, lastValidBlockHeight });
  if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  if (store) await recoverCompletions(store, conn, 1).catch((e) => console.error("[sponsor] completion recovery pending", e));
  return sig;
}
