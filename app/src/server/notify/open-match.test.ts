import { describe, expect, it, vi } from "vitest";
import { testDb } from "../history/test-db";
import { MemoryOpenMatchStore, rpcOpenMatchStore, type OpenMatchStore } from "./open-match";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const A = { account: "accountA", authority: "authorityOfA" };
const B = { account: "accountB", authority: "authorityOfB" };
const open = (s: OpenMatchStore, state = "m1") => s.open({ matchState: state, matchKey: "accountA-1", game: "holdem", entry: 100, opener: A });

// The same behavior from the in-memory store (used by other tests) and the Postgres functions (production).
const stores: [string, () => Promise<{ store: OpenMatchStore; sql?: import("@electric-sql/pglite").PGlite }>][] = [
  ["in memory", async () => ({ store: new MemoryOpenMatchStore() })],
  ["Postgres", async () => { const { rpc, sql } = await testDb(); return { store: rpcOpenMatchStore(rpc), sql }; }],
];

describe.each(stores)("the open-Match table (%s)", (_name, make) => {
  it("keeps an opened Match without a deadline until someone joins", async () => {
    const { store } = await make();
    await open(store);
    expect(await store.get("m1")).toEqual({ matchState: "m1", matchKey: "accountA-1", game: "holdem", entry: 100, players: [A], deadline: null });
    expect(await store.toCheck()).toEqual([]);
    expect(await store.get("nope")).toBeNull();
  });

  it("sets the deadline at the first join and moves it on an extend", async () => {
    const { store } = await make();
    await open(store);
    await store.join("m1", B, 5000);
    await store.join("m1", B, 6000);
    expect(await store.get("m1")).toMatchObject({ players: [A, B], deadline: 5000 });
    await store.extend("m1", 9000);
    expect((await store.toCheck()).map((m) => [m.matchState, m.deadline])).toEqual([["m1", 9000]]);
  });

  it("opening again changes nothing", async () => {
    const { store } = await make();
    await open(store);
    await store.join("m1", B, 5000);
    await open(store);
    expect(await store.get("m1")).toMatchObject({ players: [A, B], deadline: 5000 });
  });

  it("drops a closed Match from the check list but still reads it, and ignores later joins and extends", async () => {
    const { store } = await make();
    await open(store);
    await store.join("m1", B, 5000);
    await store.close("m1");
    await store.extend("m1", 1);
    expect(await store.toCheck()).toEqual([]);
    expect((await store.get("m1"))!.deadline).toBe(5000);
  });

  it("stops listing a Match once its Delayed email is told", async () => {
    const { store } = await make();
    await open(store);
    await store.join("m1", B, 5000);
    await store.delayedTold("m1");
    expect(await store.toCheck()).toEqual([]);
  });
});

describe("pruning", () => {
  it("drops long-closed and long-expired Matches only", async () => {
    const { rpc, sql } = await testDb();
    const store = rpcOpenMatchStore(rpc);
    for (const s of ["fresh", "closed-old", "expired", "closed-new"]) await open(store, s);
    await store.join("fresh", B, 1_000_000);
    await store.join("expired", B, 1_000_000 - 8 * 86400);
    await store.join("closed-old", B, 1_000_000);
    await store.close("closed-old");
    await store.close("closed-new");
    await sql.query("update public.open_match set closed_at = now() - interval '4 days' where match_state = 'closed-old'");
    expect(await store.prune(1_000_000)).toBe(2);
    expect(await store.get("fresh")).not.toBeNull();
    expect(await store.get("closed-new")).not.toBeNull();
    expect(await store.get("expired")).toBeNull();
  });
});
