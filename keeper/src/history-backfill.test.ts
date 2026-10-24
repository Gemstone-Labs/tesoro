import assert from "node:assert/strict";
import { it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { GAME_IDS } from "../../app/src/lib/chain/games.ts";
import { backfillHistory } from "./history-backfill.ts";
import { collectSignatures } from "./events-scan.ts";
import { eventTx, scriptedConn } from "./fixtures.ts";

const player = Keypair.generate().publicKey;
const connOf = () => scriptedConn([1, 2].map((n) => ({ signature: `backfill${n}`, tx: eventTx({ events: [
  { name: "MatchWon", body: { opener: player, n: BigInt(n), game: GAME_IDS.holdem, entry: 100n, player, funder: player, points: 5n, pool_fee: 2n, season: 3, ts: 1n, loser: player, challenge: false, asset: 0, opened_at: 0n } },
] }) })));

it("a credentialed dry run decodes records and never calls the available database sink", async () => {
  const conn = connOf();
  const sigs = (await collectSignatures(conn as any)).reverse();
  const writes: string[] = [];
  const sink = async (tx: { signature: string }) => { writes.push(tx.signature); };
  assert.deepEqual(await backfillHistory(conn as any, sigs, { dryRun: true, sink }), { records: 2, written: 0 });
  assert.deepEqual(writes, []);
  assert.deepEqual(await backfillHistory(conn as any, sigs, { dryRun: false, sink }), { records: 2, written: 2 });
  assert.deepEqual(writes, sigs.map((s) => s.signature));
});

it("an unreadable transaction fails the dry-run completeness check without writing", async () => {
  const conn = connOf(), sigs = await collectSignatures(conn as any);
  conn.getTransaction = async () => null;
  await assert.rejects(backfillHistory(conn as any, sigs, { dryRun: true, sink: async () => { assert.fail("must not write"); } }), /could not be read/);
});
