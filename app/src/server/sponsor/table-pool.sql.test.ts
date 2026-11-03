/** Runs migrations 0021 and 0023 on an in-process Postgres (pglite): the pool is kept by the server, not by a keeper loop. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vi, beforeAll, beforeEach, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let db: PGlite;
const sql = (name: string) => readFileSync(join(__dirname, "../../../supabase/migrations", name), "utf8");
const q = async <T>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows;
const claim = async (game: string, idx: number, epoch: number, match: string) => (await q<{ v: boolean }>("select public.claim_table($1, 1, $2, $3, $4) as v", [game, idx, epoch, match]))[0].v;
const free = async (match: string, advanced: boolean) => (await q<{ v: boolean }>("select public.free_table($1, $2) as v", [match, advanced]))[0].v;
const free_rows = () => q<{ idx: number; epoch: string }>("select idx, epoch::text from public.table_pool where game = 'holdem' and claimed_match is null and epoch_known order by idx");
const publish = (tables: { index: number; epoch: number }[], readAt = "now()") =>
  q(`select public.publish_table_pool('holdem', $1::jsonb, ${readAt})`, [JSON.stringify(tables.map((t) => ({ generation: 1, index: t.index, epoch: String(t.epoch) })))]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(sql("0021_table_leases.sql"));
  await db.exec(sql("0023_table_pool_claims.sql"));
});
beforeEach(() => db.exec("delete from public.table_pool"));

describe("table pool kept by the server (migration 0023)", () => {
  it("a claimed table leaves the free list; many claims at once give it to one Match", async () => {
    await publish([{ index: 0, epoch: 4 }, { index: 1, epoch: 4 }]);
    const got = await Promise.all(Array.from({ length: 10 }, (_, i) => claim("holdem", 0, 4, `m${i}`)));
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await free_rows()).toEqual([{ idx: 1, epoch: "4" }]);
  });

  it("a claim at another epoch than the pool's is refused", async () => {
    await publish([{ index: 0, epoch: 4 }]);
    expect(await claim("holdem", 0, 3, "m")).toBe(false);
  });

  it("freeing a Match that ran gives its table back at the next epoch", async () => {
    await publish([{ index: 0, epoch: 4 }]);
    await claim("holdem", 0, 4, "m1");
    expect(await free("m1", true)).toBe(true);
    expect(await free_rows()).toEqual([{ idx: 0, epoch: "5" }]);
    expect(await free("m1", true)).toBe(false);
  });

  it("freeing a Match whose run is unknown keeps the table out until the rollup is read", async () => {
    await publish([{ index: 0, epoch: 4 }]);
    await claim("holdem", 0, 4, "m1");
    await free("m1", false);
    expect(await free_rows()).toEqual([]);
    await publish([{ index: 0, epoch: 5 }]);
    expect(await free_rows()).toEqual([{ idx: 0, epoch: "5" }]);
  });

  it("publishing keeps a claim made after the rollup was read, and clears an old one the rollup shows free", async () => {
    await publish([{ index: 0, epoch: 4 }, { index: 1, epoch: 4 }]);
    await claim("holdem", 0, 4, "fresh");
    await claim("holdem", 1, 4, "old");
    await db.exec("update public.table_pool set claimed_at = now() - interval '10 minutes' where idx = 1");
    await publish([{ index: 0, epoch: 4 }, { index: 1, epoch: 6 }]);
    expect(await free_rows()).toEqual([{ idx: 1, epoch: "6" }]);
  });

  it("publishing leaves a claimed table the rollup does not list, and other Games", async () => {
    await publish([{ index: 0, epoch: 4 }, { index: 1, epoch: 4 }]);
    await q("select public.publish_table_pool('vanguard', '[{\"generation\":1,\"index\":0,\"epoch\":\"1\"}]', now())");
    await claim("holdem", 0, 4, "m");
    await publish([]);
    expect((await q("select idx from public.table_pool where game = 'holdem' order by idx")).length).toBe(2);
    expect((await q("select idx from public.table_pool where game = 'vanguard'")).length).toBe(1);
  });
});
