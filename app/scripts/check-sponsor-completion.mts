/** Read-only chain replay into an isolated Postgres. It neither broadcasts nor touches the runtime database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import bs58 from "bs58";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { completionEffects, completionInput, completionStore, recoverCompletions } from "../src/server/sponsor/completion";

type Hold = { key: string; lamports: string; generation: string };
const signature = process.argv[2];
assert(signature, "Usage: pnpm --filter @tesoro/keeper exec tsx ../app/scripts/check-sponsor-completion.mts <finalized close signature>");
const conn = new Connection(process.env.TESORO_COMPLETION_REPLAY_RPC ?? "https://rpc.magicblock.app/devnet", "finalized");
const response = await conn.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
assert(response?.meta && !response.meta.err, "A finalized successful transaction is required");
const keys = response.transaction.message.getAccountKeys({ accountKeysFromLookups: response.meta.loadedAddresses });
const ixs = response.transaction.message.compiledInstructions.map((ix) => ({
  programId: keys.get(ix.programIdIndex)!, keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys.get(i)!, isSigner: false, isWritable: true })), data: ix.data,
}));
const effects = completionEffects(ixs);
assert(effects.closes.length, "The transaction must physically close a Match or Ticket");
const tx = new VersionedTransaction(response.transaction.message);
tx.signatures = response.transaction.signatures.map((s) => bs58.decode(s));
const db = new PGlite();
try {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  for (const migration of ["0011_sponsor.sql", "0017_sponsor_completion.sql"]) await db.exec(readFileSync(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  for (const address of effects.closes) await db.query("insert into sponsor_hold(key,lamports) values($1,300000)", [address]);
  await db.exec("insert into sponsor_hold(key,lamports) values ('unrelated',900)");
  const store = completionStore(async (fn, args) => (await db.query<{ value: unknown }>(`select ${fn}(${Object.values(args).map((_, i) => `$${i + 1}`).join(",")}) as value`, Object.values(args))).rows[0].value);
  const before = (await db.query<Hold>("select key,lamports::text,generation from sponsor_hold order by key")).rows;
  await store.prepareCompletion(completionInput(tx, effects, 0n));
  assert.equal(await recoverCompletions(store, { getTransaction: async () => response }), 1);
  const after = (await db.query<Hold>("select key,lamports::text,generation from sponsor_hold order by key")).rows;
  assert.deepEqual(after, before.filter((r) => r.key === "unrelated"));
  console.log(JSON.stringify({ scope: "Finalized chain replay; isolated Postgres seeded reserves; not deployed Privy evidence", signature, slot: response.slot, targets: effects.closes, before, after, rentReturnedLamports: effects.closes.reduce((n, address) => {
    const index = Array.from({ length: keys.length }, (_, i) => i).find((i) => keys.get(i)?.toBase58() === address)!;
    return n + response.meta!.preBalances[index] - response.meta!.postBalances[index];
  }, 0) }, null, 2));
} finally { await db.close(); }
