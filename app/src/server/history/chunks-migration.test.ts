import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
const migration = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const correction = () => migration("0015_match_history_chunks.sql");

it("repairs one-based counts from retained events, preserves financial data and privileges, and is idempotent", async () => {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(migration("0010_match_history.sql"));
  const ingest = (p: object) => db.query("select public.ingest_match_event($1::jsonb)", [JSON.stringify(p)]);
  for (const [n, chunks, settled] of [[1, [1, 2], 2], [2, [], 4], [3, [4], null]] as const) {
    for (const c of chunks) await ingest({ type: "chunk", event_id: `${n}:${c}`, opener: "account", n, chunk_no: c });
    if (settled !== null) await ingest({ type: "settled", event_id: `${n}:settled`, opener: "account", n, chunks: settled, kind: 0, ts: 1 });
  }
  await db.exec("insert into public.match_history(opener,n,chunks) values ('no-count-evidence',9,11); update public.match_history set entry=100, platform_fee=4, studio_fee=6, leaderboard_fee=2, scores='[10,20]';");
  const otherColumns = () => db.query("select to_jsonb(h)-'chunks' as row from public.match_history h order by opener,n");
  const events = () => db.query("select * from public.match_events order by event_id");
  const acl = () => db.query("select proowner,proacl from pg_proc where oid='public.ingest_match_event(jsonb)'::regprocedure");
  const before = { rows: await otherColumns(), events: await events(), acl: await acl() };
  const apply = () => db.exec("begin;\n" + correction() + "\ncommit;");
  await apply();
  expect((await db.query<{ chunks: number }>("select chunks from public.match_history order by opener,n")).rows.map((r) => r.chunks)).toEqual([2, 4, 4, 11]);
  expect(await otherColumns()).toEqual(before.rows);
  expect(await events()).toEqual(before.events);
  expect(await acl()).toEqual(before.acl);
  await apply();
  // Repeated terminal crank and new chunks retain the core's cumulative number.
  await ingest({ type: "chunk", event_id: "1:retry", opener: "account", n: 1, chunk_no: 2 });
  expect((await db.query<{ chunks: number }>("select chunks from public.match_history where opener='account' and n=1")).rows[0].chunks).toBe(2);
  await db.close();
});

it("refuses ambiguous zero-based retained events before replacing the function", async () => {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(migration("0010_match_history.sql"));
  await db.query("select public.ingest_match_event($1::jsonb)", [JSON.stringify({ type: "chunk", event_id: "bad", opener: "a", n: 1, chunk_no: 0 })]);
  await expect(db.exec("begin;\n" + correction() + "\ncommit;")).rejects.toThrow(/Invalid Match chunk counters/);
  await db.exec("rollback;");
  expect((await db.query<{ chunks: number }>("select chunks from public.match_history")).rows[0].chunks).toBe(1);
  await db.close();
});
