import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { it } from "vitest";
const MIG = ["0010_match_history.sql", "0013_match_end_states.sql", "0015_match_history_chunks.sql", "0016_match_source_lines.sql", "0020_webhook_tx.sql", "0021_table_leases.sql", "0022_notify_webhook.sql", "0023_table_pool_claims.sql", "0025_end_state_missing.sql", "0026_table_pool_dead_rows.sql", "0027_railcar_history.sql"];
it("t", async () => {
  for (let i = 0; i < 2; i++) {
    let t = Date.now(); const sql = new PGlite(); await sql.waitReady; console.log("P init", Date.now() - t);
    t = Date.now(); await sql.exec("create role anon; create role authenticated; create role service_role bypassrls;"); console.log("P roles", Date.now() - t);
    for (const m of MIG) { t = Date.now(); await sql.exec("begin;\n" + readFileSync(new URL(`../../../supabase/migrations/${m}`, import.meta.url), "utf8") + "\ncommit;"); console.log("P", m, Date.now() - t); }
    t = Date.now(); const d = await sql.dumpDataDir("none"); console.log("P dump", Date.now() - t, d.size);
    t = Date.now(); const s2 = new PGlite({ loadDataDir: d }); await s2.waitReady; console.log("P load", Date.now() - t);
    await sql.close(); await s2.close();
  }
}, 120000);
