/** Runs migration 0008 on an in-process Postgres (pglite): the quota function must never hand out more than its max. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vi, beforeAll, describe, expect, it } from "vitest";

// A fresh in-process Postgres takes several seconds to start when the machine is busy.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let db: PGlite;

const take = async (key: string, cost: number, max: number | null, windowMs: number | null) =>
  Number((await db.query<{ v: string }>("select public.sponsor_take($1, $2, $3, $4) as v", [key, cost, max, windowMs])).rows[0].v);

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(readFileSync(join(__dirname, "../../../supabase/migrations/0008_sponsor.sql"), "utf8"));
});

describe("sponsor_take (migration 0008)", () => {
  it("applies and counts up to the max, then refuses without adding", async () => {
    expect(await take("a", 1, 3, 60_000)).toBe(1);
    expect(await take("a", 2, 3, 60_000)).toBe(3);
    expect(await take("a", 1, 3, 60_000)).toBe(-1);
    expect(await take("a", 0, null, 60_000)).toBe(3);
  });

  it("many simultaneous takes never exceed the limit", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => take("burst", 1, 7, 60_000)));
    expect(results.filter((r) => r >= 0)).toHaveLength(7);
    expect(await take("burst", 0, null, 60_000)).toBe(7);
  });

  it("refunds give back and never go below zero; add counts over the max", async () => {
    await take("r", 2, 5, 60_000);
    expect(await take("r", -1, null, null)).toBe(1);
    expect(await take("r", -10, null, null)).toBe(0);
    expect(await take("f", 30, null, 60_000)).toBe(30);
  });

  it("starts a new window once the old one is over", async () => {
    await take("w", 3, 3, 1_000);
    expect(await take("w", 1, 3, 1_000)).toBe(-1);
    await db.exec("update public.sponsor_usage set window_start = now() - interval '2 seconds' where key = 'w'");
    expect(await take("w", 1, 3, 1_000)).toBe(1);
  });

  it("is closed to the anon and authenticated roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(take("x", 1, 1, 1000)).rejects.toThrow();
      await db.exec("reset role");
    }
  });
});
