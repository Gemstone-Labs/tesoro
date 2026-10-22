import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Rpc } from "./rpc";

const MIGRATIONS = ["0007_match_history.sql", "0010_match_end_states.sql"].map((f) => new URL(`../../../supabase/migrations/${f}`, import.meta.url));

/** A throwaway in-process Postgres (pglite) with migrations 0007 and 0010 applied, called the way the app calls Supabase. */
export async function testDb(): Promise<{ rpc: Rpc; sql: PGlite }> {
  const sql = new PGlite();
  await sql.exec("create role anon; create role authenticated;");
  for (const m of MIGRATIONS) await sql.exec(readFileSync(m, "utf8"));
  const rpc: Rpc = async (fn, args) => {
    const names = Object.keys(args);
    const params = names.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
    const call = names.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const res = await sql.query<Record<string, unknown>>(`select public.${fn}(${call}) as r`, params);
    return res.rows[0].r;
  };
  return { rpc, sql };
}
