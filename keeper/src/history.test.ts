import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { eventTx, scriptedConn } from "./fixtures.ts";
import { databaseSink, memoryCursor, notifySink, scanHistory, startedRuns, type HistoryDeps, type Sink } from "./history.ts";
import { collectSignatures } from "./events-scan.ts";
import { GAME_IDS } from "../../app/src/lib/chain/games.ts";

/** The app's throwaway Postgres (pglite + migration 0010). Loaded by a computed path: it belongs to the app's build, not the keeper's. */
const testDb = async (): Promise<{ rpc: (fn: string, args: Record<string, unknown>) => Promise<any>; sql: { query: (q: string) => Promise<{ rows: any[] }> } }> => {
  const path = "../../app/src/server/history/test-db.ts";
  return (await import(path)).testDb();
};
const accountHistory = (rpc: (fn: string, args: Record<string, unknown>) => Promise<any>, account: string, page: number, size: number) => rpc("history_page", { p_account: account, p_page: page, p_size: size });

type Tx = { signature: string; tx: ReturnType<typeof eventTx> | null };
const k = () => Keypair.generate().publicKey;
const [ALICE, BOB] = [k(), k()];
const T0 = 1_800_000_000;

/** One finished Match as core emits it: the run start (+ MatchWon) and the settled record. */
function matchEvents(n: number, winner: 0 | 1) {
  const zero = PublicKey.default;
  const base = { opener: ALICE, n: BigInt(n) };
  return [
    { name: "MatchWon", body: { ...base, game: GAME_IDS.holdem, entry: 500n, player: winner === 0 ? ALICE : BOB, funder: winner === 0 ? ALICE : BOB, points: 5n, pool_fee: 10n, season: 3, ts: BigInt(T0 + n * 100), loser: winner === 0 ? BOB : ALICE, challenge: false, asset: 0, opened_at: BigInt(T0 + n * 100 - 600) } },
    {
      name: "MatchRunStarted",
      body: { ...base, game: GAME_IDS.holdem, kind: 0, winner, entry: 500n, fees: [20n, 30n, 10n], a_player: ALICE, a_funder: ALICE, b_player: BOB, b_funder: BOB, challenge: false, asset: 0, opened_at: BigInt(T0 + n * 100 - 600), ts: BigInt(T0 + n * 100), a_share_bps: 0, b_share_bps: 0 },
    },
    { name: "MatchSettled", body: { ...base, kind: 0, chunks: 1 } },
  ];
}

/** `count` transactions, newest first as the RPC lists them. */
const history = (count: number): Tx[] =>
  Array.from({ length: count }, (_, i) => count - i).map((n) => ({ signature: `sig${String(n).padStart(3, "0")}`, tx: eventTx({ slot: n, blockTime: T0 + n * 100, events: matchEvents(n, n % 2 === 0 ? 0 : 1) }) }));

const depsOf = (conn: ReturnType<typeof scriptedConn>, sinks: Sink[], over: Partial<HistoryDeps> = {}): HistoryDeps => ({
  conn: conn as any,
  cursor: memoryCursor(),
  sinks,
  perPass: 100,
  firstRunPages: 3,
  fetchConcurrency: 3,
  skipAfter: 3,
  ...over,
});

describe("the Match history scan", () => {
  it("hands transactions to the sinks oldest first and moves the cursor to the newest", async () => {
    const seen: string[] = [];
    const deps = depsOf(scriptedConn(history(5)), [async (tx) => void seen.push(tx.signature)]);
    const r = await scanHistory(deps);
    assert.deepEqual(seen, ["sig001", "sig002", "sig003", "sig004", "sig005"]);
    assert.equal(deps.cursor.load(), "sig005");
    assert.equal(r.handled, 5);
    assert.equal((await scanHistory(deps)).handled, 0, "nothing new");
  });

  it("only reads what is newer than the cursor", async () => {
    const conn = scriptedConn(history(6));
    const deps = depsOf(conn, [async () => undefined], { cursor: memoryCursor("sig004") });
    await scanHistory(deps);
    assert.deepEqual(conn.calls.get.sort(), ["sig005", "sig006"]);
  });

  it("stops at the transaction a sink failed on and resumes there", async () => {
    let fail = true;
    const seen: string[] = [];
    const sink: Sink = async (tx) => {
      if (tx.signature === "sig003" && fail) throw new Error("database down");
      seen.push(tx.signature);
    };
    const deps = depsOf(scriptedConn(history(5)), [sink]);
    const first = await scanHistory(deps);
    assert.deepEqual([first.handled, first.stoppedAt, deps.cursor.load()], [2, "sig003", "sig002"]);
    fail = false;
    await scanHistory(deps);
    assert.deepEqual(seen, ["sig001", "sig002", "sig003", "sig004", "sig005"], "nothing skipped, nothing twice after the cursor");
    assert.equal(deps.cursor.load(), "sig005");
  });

  it("handles a bounded number per pass, oldest first, so a long outage is worked off in order", async () => {
    const seen: string[] = [];
    const deps = depsOf(scriptedConn(history(7)), [async (tx) => void seen.push(tx.signature)], { perPass: 3 });
    await scanHistory(deps);
    assert.deepEqual(seen, ["sig001", "sig002", "sig003"]);
    await scanHistory(deps);
    await scanHistory(deps);
    assert.deepEqual(seen, ["sig001", "sig002", "sig003", "sig004", "sig005", "sig006", "sig007"]);
  });

  it("never advances past an unreadable transaction, and resumes when it becomes readable", async () => {
    const txs = history(3);
    txs[1] = { signature: txs[1].signature, tx: null };
    const seen: string[] = [];
    const conn = scriptedConn(txs);
    const deps = depsOf(conn, [async (tx) => void seen.push(tx.signature)], { skipAfter: 3 });
    assert.equal((await scanHistory(deps)).stoppedAt, "sig002");
    assert.equal((await scanHistory(deps)).stoppedAt, "sig002");
    assert.equal((await scanHistory(deps)).stoppedAt, "sig002");
    assert.equal(deps.cursor.load(), "sig001");
    assert.deepEqual(seen, ["sig001"]);
    const readable = scriptedConn(history(3));
    await scanHistory({ ...deps, conn: readable as any });
    assert.deepEqual(seen, ["sig001", "sig002", "sig003"]);
  });

  it("ignores failed transactions", async () => {
    const txs = history(3);
    txs[1] = { signature: txs[1].signature, tx: eventTx({ slot: 2, failed: true, events: [] }) };
    assert.deepEqual((await collectSignatures(scriptedConn(txs) as any)).map((s) => s.signature), ["sig003", "sig001"]);
  });

  it("collects across pages", async () => {
    const sigs = await collectSignatures(scriptedConn(history(25)) as any, { pageSize: 10 });
    assert.equal(sigs.length, 25);
    assert.equal(sigs[0].signature, "sig025");
  });
});

describe("notification feed", () => {
  it("remembers run starts, not other records", async () => {
    startedRuns.length = 0;
    await scanHistory(depsOf(scriptedConn(history(2)), [notifySink]));
    assert.equal(startedRuns.length, 2);
    assert.equal(startedRuns[0].start.n, 1n);
  });
});

describe("the history tables", () => {
  it("a backfill in one go builds the same history as the live writer one transaction at a time", async () => {
    const [live, backfill] = await Promise.all([testDb(), testDb()]);
    const txs = history(12);
    const liveDeps = depsOf(scriptedConn(txs), [databaseSink(live.rpc)], { perPass: 1 });
    for (let i = 0; i < 12; i++) await scanHistory(liveDeps);
    await scanHistory(depsOf(scriptedConn(txs), [databaseSink(backfill.rpc)], { perPass: 1000 }));
    const rows = async (db: typeof live) => (await db.sql.query(`select event_id from public.match_events order by event_id`)).rows;
    const liveRows = await rows(live);
    assert.ok(liveRows.length >= 12 * 3 - 12, `rows ${liveRows.length}`);
    assert.deepEqual(await rows(backfill), liveRows);
    const page = async (db: typeof live) => accountHistory(db.rpc, ALICE.toBase58(), 1, 50);
    assert.deepEqual(await page(backfill), await page(live));
    assert.equal((await page(live)).total, 12);
  });

  it("running the same transactions again changes nothing", async () => {
    const db = await testDb();
    const txs = history(4);
    await scanHistory(depsOf(scriptedConn(txs), [databaseSink(db.rpc)]));
    const before = (await db.sql.query(`select count(*)::int as n from public.match_events`)).rows[0];
    await scanHistory(depsOf(scriptedConn(txs), [databaseSink(db.rpc)]));
    assert.deepEqual((await db.sql.query(`select count(*)::int as n from public.match_events`)).rows[0], before);
  });
});
