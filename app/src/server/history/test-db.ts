import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Rpc } from "./rpc";

const MIGRATIONS = ["0010_match_history.sql", "0013_match_end_states.sql", "0015_match_history_chunks.sql", "0016_match_source_lines.sql", "0020_webhook_tx.sql", "0021_table_leases.sql", "0022_notify_webhook.sql", "0023_table_pool_claims.sql", "0025_end_state_missing.sql", "0026_table_pool_dead_rows.sql", "0027_railcar_history.sql"].map((f) => new URL(`../../../supabase/migrations/${f}`, import.meta.url));

/**
 * The migrated database as a data directory, built once per test file: starting Postgres (initdb) costs ~2 s, loading a copy
 * of its directory ~0.4 s, and a file builds dozens of databases.
 */
let template: Promise<File | Blob> | null = null;
async function migrated(): Promise<File | Blob> {
  const sql = new PGlite();
  // Supabase's trusted server role bypasses RLS; anon/authenticated do not.
  await sql.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const m of MIGRATIONS) await sql.exec("begin;\n" + readFileSync(m, "utf8") + "\ncommit;");
  const dir = await sql.dumpDataDir("none");
  await sql.close();
  return dir;
}

/** A throwaway in-process Postgres with the current history migrations, called the way the app calls Supabase. */
export async function testDb(): Promise<{ rpc: Rpc; sql: PGlite }> {
  template ??= migrated();
  const sql = new PGlite({ loadDataDir: await template });
  await sql.waitReady;
  const rpc: Rpc = async (fn, args) => {
    const names = Object.keys(args);
    const params = names.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
    const call = names.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const res = await sql.query<Record<string, unknown>>(`select public.${fn}(${call}) as r`, params);
    return res.rows[0].r;
  };
  return { rpc, sql };
}
