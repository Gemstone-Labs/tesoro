import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { recordsOfRawTx, type RawTx } from "../../app/src/server/history/webhook.ts";
import { ingestMatchRecords } from "../../app/src/server/history/ingest.ts";
import { railcarHistoryPass, type RideChain } from "./railcar-history.ts";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>;
type Sql = { query: (q: string, params?: unknown[]) => Promise<{ rows: any[] }> };
/** The app's throwaway Postgres with the history migrations through 0027. Loaded by a computed path, as history.test.ts does. */
const testDb = async (): Promise<{ rpc: Rpc; sql: Sql }> => {
  const path = "../../app/src/server/history/test-db.ts";
  return (await import(path)).testDb();
};

/** The two live devnet rides of 2026-11-08 (Match AYi87PsH…-24 and -25): reveal, finalize, chunks, closes. */
const live = JSON.parse(readFileSync(new URL("./fixtures/railcar-live-rides-2026-11-08.json", import.meta.url), "utf8")) as { txs: { ride: string; what: string; signature: string; tx: RawTx }[] };
/** A head-to-head Match (AYi87PsH…-5) as Helius delivered it on 2026-11-04. */
const headToHead = (JSON.parse(readFileSync(new URL("../../app/src/server/history/fixtures/helius-delivery-real-2026-11-04.json", import.meta.url), "utf8")) as RawTx[]).map((tx) => ({ signature: tx.transaction.signatures[0], tx }));

const CORE_EA = "34PoG3e8haf8gSC1EsfwpWwjXEXdpWng4eqPuXcW1iEz";
const RAILCAR_EA = "47mNsiWYTq2LfK6KsPmyrabdVum91Dp73XAkxohVTcxr";
const OPENER = "AYi87PsHmD5i5s4JKJwfZxr9Wd3zWrVk35cASEuogSrN";
const [QSA, QSB, QED, QEF, QH1] = [OPENER, "5scTF4pJ6FiCjAkih6doU9xn1ZQG86TGDz1HS17hUDfp", "68Ea6ZcZBcLJFL8WuXh214AmSPdMDyTxMUx6cQJRYnue", "3rPpsgb7boPLeFKZKeT9H6jBjSxrzGyruSKXbjgeoW71", "EYhanGJfChJhp7BGQMcwKwaBEktdfyhX5S6LKMCr5ABv"];
/** Each Player's Gema change as the live run read it from their Accounts (rc-live log, "GEMAS ... before/now"). */
const LIVE_DELTAS = {
  24: { [QSA]: 405, [QSB]: 945, [QED]: -500, [QEF]: -500, [QH1]: -500 },
  25: { [QSA]: -100, [QSB]: 71, [QED]: 118, [QEF]: 285, [QH1]: -500 },
};

const isRailcarTx = (tx: RawTx) => [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].includes(RAILCAR_EA);

/** The chain as RPC lists it: every live and head-to-head transaction under core's event authority, the reveals under Railcar's too. */
function chainOf(txs: { signature: string; tx: RawTx }[]): RideChain & { fetched: string[] } {
  const bySig = new Map(txs.map((t) => [t.signature, t.tx]));
  const fetched: string[] = [];
  const newestFirst = (list: { signature: string; tx: RawTx }[]) => [...list].sort((a, b) => b.tx.slot - a.tx.slot).map((t) => t.signature);
  return {
    fetched,
    signatures: async (address, sinceTs) => {
      const inWindow = txs.filter((t) => (t.tx.blockTime ?? 0) >= sinceTs && (t.tx.meta?.innerInstructions?.length ?? 0) > 0);
      if (address === CORE_EA) return newestFirst(inWindow);
      if (address === RAILCAR_EA) return newestFirst(inWindow.filter((t) => isRailcarTx(t.tx)));
      return [];
    },
    transaction: async (signature) => {
      fetched.push(signature);
      return bySig.get(signature) ?? null;
    },
  };
}

/** What production does today: it stores every core transaction in webhook_tx, writes the records main's decoder knows and marks the row decoded. */
async function productionDecodes(rpc: Rpc, txs: { signature: string; tx: RawTx }[]) {
  for (const { signature, tx } of txs) {
    await rpc("webhook_store_tx", { p: { signature, slot: tx.slot, blockTime: tx.blockTime, body: tx, finalized: true } });
    // main skips the Railcar and many-seat events; it does write a many-seat MatchWon (as `won`) and every head-to-head record.
    const known = recordsOfRawTx(tx).filter((r) => r.type === "won" || r.type === "start" || r.type === "settled" || (r.type === "chunk" && !r.seatLines) || r.type.startsWith("line"));
    const manySeat = new Set(recordsOfRawTx(tx).filter((r) => r.type === "seats-start" || r.type === "ride" || (r.type === "chunk" && r.seatLines)).map((r) => `${r.opener}-${r.n}`));
    const written = known.filter((r) => r.type === "won" || !manySeat.has(`${r.opener}-${r.n}`));
    if (written.length) await ingestMatchRecords(rpc, written, { signature, slot: tx.slot, finalized: true, gameOf: (p) => (new PublicKey(p).toBase58() === "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam" ? null : "holdem") });
    await rpc("webhook_mark_decoded", { p_signature: signature, p_error: null });
  }
}

const snapshot = async (sql: Sql) => ({
  webhook: (await sql.query("select signature, decoded_at, decode_error from public.webhook_tx order by signature")).rows,
  history: (await sql.query("select * from public.match_history order by opener, n")).rows,
  parties: (await sql.query("select opener, n, account, role, side, result, delta from public.match_parties order by opener, n, side, account, role")).rows,
  events: (await sql.query("select event_id from public.match_events order by event_id")).rows.map((r) => r.event_id),
});

const deltasOf = async (sql: Sql, n: number) =>
  Object.fromEntries((await sql.query("select account, delta from public.match_parties where opener = $1 and n = $2 and role = 'player'", [OPENER, n])).rows.map((r) => [r.account, Number(r.delta)]));

const ALL = [...live.txs, ...headToHead];
const SINCE = 0;

describe("the Railcar history sidecar", () => {
  it("gives rides that production already decoded their Railcar rows, and leaves webhook_tx and head-to-head rows alone", async () => {
    const { rpc, sql } = await testDb();
    await productionDecodes(rpc, ALL);
    assert.deepEqual(await deltasOf(sql, 24), {}, "production wrote no ride parties");
    const before = await snapshot(sql);

    const r = await railcarHistoryPass({ chain: chainOf(ALL), rpc, sinceTs: SINCE, dryRun: false });

    assert.deepEqual(await deltasOf(sql, 24), LIVE_DELTAS[24]);
    assert.deepEqual(await deltasOf(sql, 25), LIVE_DELTAS[25]);
    const after = await snapshot(sql);
    assert.deepEqual(after.webhook, before.webhook, "decoded_at and decode_error untouched");
    const h2h = (s: typeof before) => ({ history: s.history.filter((m) => Number(m.n) === 5), parties: s.parties.filter((p) => Number(p.n) === 5) });
    assert.deepEqual(h2h(after), h2h(before), "head-to-head rows untouched");
    assert.deepEqual(r.matches.sort(), [`${OPENER}-24`, `${OPENER}-25`]);
    assert.ok(r.added > 0);
  });

  it("changes nothing when it runs again, even with a fresh process", async () => {
    const { rpc, sql } = await testDb();
    await productionDecodes(rpc, ALL);
    await railcarHistoryPass({ chain: chainOf(ALL), rpc, sinceTs: SINCE, dryRun: false });
    const once = await snapshot(sql);

    const again = await railcarHistoryPass({ chain: chainOf(ALL), rpc, sinceTs: SINCE, dryRun: false });

    assert.equal(again.added, 0);
    assert.deepEqual(await snapshot(sql), once);
  });

  it("does not fetch again what this process already handled", async () => {
    const { rpc } = await testDb();
    const seen = new Set<string>();
    await railcarHistoryPass({ chain: chainOf(ALL), rpc, sinceTs: SINCE, dryRun: false, seen });
    const chain = chainOf(ALL);
    const r = await railcarHistoryPass({ chain, rpc, sinceTs: SINCE, dryRun: false, seen });
    assert.deepEqual(chain.fetched, []);
    assert.equal(r.scanned, 0);
  });

  it("never writes a head-to-head Match, even one production has not decoded yet", async () => {
    const { rpc, sql } = await testDb();

    await railcarHistoryPass({ chain: chainOf(ALL), rpc, sinceTs: SINCE, dryRun: false });

    const h2h = await sql.query("select n from public.match_history where n = 5");
    assert.deepEqual(h2h.rows, []);
    assert.deepEqual((await sql.query("select signature from public.webhook_tx")).rows, [], "nothing stored in webhook_tx");
    assert.deepEqual(await deltasOf(sql, 25), LIVE_DELTAS[25], "rides that never reached webhook_tx are filled too");
  });

  it("only reports what it would write on a dry run", async () => {
    const { sql } = await testDb();
    const lines: string[] = [];

    const r = await railcarHistoryPass({ chain: chainOf(ALL), rpc: null, sinceTs: SINCE, dryRun: true, log: (l) => lines.push(l) });

    assert.deepEqual(r.matches.sort(), [`${OPENER}-24`, `${OPENER}-25`]);
    assert.equal(r.added, 0);
    assert.equal((await sql.query("select count(*)::int as c from public.match_events")).rows[0].c, 0);
    assert.ok(lines.some((l) => l.startsWith(`would ingest ${OPENER}-24 ride from r1-reveal-1`)), lines.join("\n"));
  });

  it("reads only the window it is given", async () => {
    const { rpc } = await testDb();
    const ride2 = Math.min(...live.txs.filter((t) => t.ride === "r2").map((t) => t.tx.blockTime ?? 0));

    const r = await railcarHistoryPass({ chain: chainOf(ALL), rpc, sinceTs: ride2, dryRun: false });

    assert.deepEqual(r.matches, [`${OPENER}-25`]);
  });
});
