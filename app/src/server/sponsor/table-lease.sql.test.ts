/** Runs migration 0020 on an in-process Postgres (pglite): two joins at once must never hold the same table. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vi, beforeAll, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let db: PGlite;
const take = async (key: string, holder: string, ttlMs: number) => (await db.query<{ v: boolean }>("select public.take_table_lease($1, $2, $3) as v", [key, holder, ttlMs])).rows[0].v;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(readFileSync(join(__dirname, "../../../supabase/migrations/0020_table_leases.sql"), "utf8"));
});

describe("table leases (migration 0020)", () => {
  it("many simultaneous takes of one table give it to exactly one holder", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => take("holdem/1/0/3", `h${i}`, 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("an expired lease is taken again; a held one is not", async () => {
    expect(await take("x", "a", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await take("x", "b", 60_000)).toBe(true);
    expect(await take("x", "c", 60_000)).toBe(false);
  });

  it("extend holds it for its holder, release frees it only for that holder", async () => {
    await take("y", "a", 1);
    await db.query("select public.extend_table_lease('y', 'a', 60000)");
    expect(await take("y", "b", 60_000)).toBe(false);
    await db.query("select public.release_table_lease('y', 'b')");
    expect(await take("y", "b", 60_000)).toBe(false);
    await db.query("select public.release_table_lease('y', 'a')");
    expect(await take("y", "b", 60_000)).toBe(true);
  });

  it("publish_table_pool replaces a Game's rows and leaves the others", async () => {
    await db.query(`select public.publish_table_pool('holdem', '[{"generation":1,"index":0,"epoch":"4"},{"generation":1,"index":2,"epoch":"9"}]')`);
    await db.query(`select public.publish_table_pool('vanguard', '[{"generation":1,"index":0,"epoch":"1"}]')`);
    await db.query(`select public.publish_table_pool('holdem', '[{"generation":1,"index":1,"epoch":"5"}]')`);
    const rows = (await db.query<{ game: string; idx: number; epoch: string }>("select game, idx, epoch::text from public.table_pool order by game, idx")).rows;
    expect(rows).toEqual([{ game: "holdem", idx: 1, epoch: "5" }, { game: "vanguard", idx: 0, epoch: "1" }]);
  });
});
