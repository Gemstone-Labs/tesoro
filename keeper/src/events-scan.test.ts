import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { GAME_IDS } from "../../app/src/lib/chain/games.ts";
import { collectSignatures, pooled, seasonWinsFromChain, winOf } from "./events-scan.ts";
import { eventTx, scriptedConn } from "./fixtures.ts";

const k = () => Keypair.generate().publicKey;
const [ALICE, BOB, EVE] = [k(), k(), k()];
const T0 = 1_800_000_000;

const won = (n: number, winner: PublicKey, loser: PublicKey, season: number, ts: number, extra: { programId?: PublicKey } = {}) => ({
  name: "MatchWon",
  programId: extra.programId,
  body: { opener: winner, n: BigInt(n), game: GAME_IDS.holdem, entry: 500n, player: winner, funder: winner, points: 5n, pool_fee: 10n, season, ts: BigInt(ts), loser, challenge: false, asset: 0, opened_at: BigInt(ts - 600) },
});

describe("a Season's wins from core's events", () => {
  it("refuses a truncated full-history scan even without a Season start bound", async () => {
    const conn = scriptedConn(Array.from({ length: 3 }, (_, i) => ({ signature: `truncated${i}`, tx: eventTx({ blockTime: T0, events: [] }) })));
    await assert.rejects(collectSignatures(conn as any, { pageSize: 1, maxPages: 2 }), /event scan stopped after 2 page/);
  });
  it("reads each MatchWon of the season, oldest first, by the season in the record", async () => {
    const conn = scriptedConn([
      { signature: "s3", tx: eventTx({ blockTime: T0 + 300, events: [won(3, BOB, ALICE, 7, T0 + 300)] }) },
      { signature: "s2", tx: eventTx({ blockTime: T0 + 200, events: [won(2, ALICE, BOB, 7, T0 + 200)] }) },
      { signature: "s1", tx: eventTx({ blockTime: T0 + 100, events: [won(1, ALICE, BOB, 6, T0 + 100)] }) },
    ]);
    const wins = await seasonWinsFromChain(conn as any, 7, T0 + 50, T0 + 1000);
    assert.deepEqual(wins.map((w) => [w.player, w.loser, w.points]), [[ALICE.toBase58(), BOB.toBase58(), 5], [BOB.toBase58(), ALICE.toBase58(), 5]]);
  });

  it("ignores a MatchWon that another program wrote (the fake-wins attack)", async () => {
    const stranger = k();
    const conn = scriptedConn([
      { signature: "f2", tx: eventTx({ blockTime: T0 + 20, events: [won(9, EVE, ALICE, 8, T0 + 20, { programId: stranger })] }) },
      { signature: "f1", tx: eventTx({ blockTime: T0 + 10, events: [won(8, ALICE, BOB, 8, T0 + 10)] }) },
    ]);
    const wins = await seasonWinsFromChain(conn as any, 8, T0, T0 + 1000);
    assert.deepEqual(wins.map((w) => w.player), [ALICE.toBase58()]);
  });

  it("does not look at transactions outside the season's span", async () => {
    const conn = scriptedConn([
      { signature: "late", tx: eventTx({ blockTime: T0 + 99_999, events: [won(5, EVE, ALICE, 9, T0 + 99_999)] }) },
      { signature: "in", tx: eventTx({ blockTime: T0 + 50, events: [won(4, ALICE, BOB, 9, T0 + 50)] }) },
      { signature: "early", tx: eventTx({ blockTime: T0 - 99_999, events: [won(3, EVE, ALICE, 9, T0 - 99_999)] }) },
    ]);
    const wins = await seasonWinsFromChain(conn as any, 9, T0, T0 + 1000);
    assert.deepEqual(wins.map((w) => w.player), [ALICE.toBase58()]);
    assert.ok(!(conn.calls.get as string[]).includes("early"), "pages stop once they reach older transactions");
  });

  it("refuses to rank on a partial scan", async () => {
    const conn = scriptedConn([
      { signature: "ok", tx: eventTx({ blockTime: T0 + 20, events: [won(2, ALICE, BOB, 10, T0 + 20)] }) },
      { signature: "gone", tx: null },
    ]);
    // a null transaction has no block time, so it is listed with none and read: it cannot be, so the scan fails
    (conn as any).getSignaturesForAddress = async () => [
      { signature: "ok", slot: 1, blockTime: T0 + 20, err: null, memo: null },
      { signature: "gone", slot: 1, blockTime: T0 + 10, err: null, memo: null },
    ];
    await assert.rejects(seasonWinsFromChain(conn as any, 10, T0, T0 + 1000), /could not be read/);
  });

  it("reads a week that spans several signature pages, and refuses when the pages run out first", async () => {
    const txs = Array.from({ length: 25 }, (_, i) => ({ signature: `p${String(25 - i).padStart(2, "0")}`, tx: eventTx({ blockTime: T0 + 1000 - i * 10, events: [won(100 - i, ALICE, BOB, 11, T0 + 1000 - i * 10)] }) }));
    const conn = scriptedConn(txs);
    const wins = await seasonWinsFromChain(conn as any, 11, T0, T0 + 2000, 0, 3, { pageSize: 10 });
    assert.equal(wins.length, 25);
    // 25 signatures at 10 a page, the first one older than the start only on page 3: two pages are not enough
    await assert.rejects(seasonWinsFromChain(scriptedConn(txs) as any, 12, T0 - 5000, T0 + 3000, 0, 3, { pageSize: 10, maxPages: 2 }), /event scan stopped after 2 page/);
  });

  it("names a Win with the loser unless it is the zero key", () => {
    const rec = (loser: string) => ({ type: "won" as const, opener: ALICE.toBase58(), n: 1n, game: "g", entry: 5, winner: ALICE.toBase58(), funder: ALICE.toBase58(), loser, points: 5, poolFee: 1, season: 1, ts: 1, challenge: false, asset: 0, openedAt: 0 });
    assert.equal(winOf(rec(BOB.toBase58())).loser, BOB.toBase58());
    assert.equal("loser" in winOf(rec(PublicKey.default.toBase58())), false);
  });
});

describe("pooled", () => {
  it("runs at most n at once and keeps the order", async () => {
    let running = 0;
    let peak = 0;
    const out = await pooled([1, 2, 3, 4, 5, 6], 2, async (x) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return x * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 2);
  });
});
