import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { cappedWins, standings } from "../../app/src/lib/chain/season.ts";
import { decodeMatchRecords, innerInstructionsOf, type MatchWonRecord } from "../../app/src/server/history/events.ts";
import { seasonWinsFromChain, winOf } from "./events-scan.ts";
import { scriptedConn } from "./fixtures.ts";
import { CORE_ID, eventAuthority } from "./kit.ts";

// The inner instructions of the worked example's settle transaction, as tesoro_core emitted them
// in LiteSVM (`tests/many_seat/settle.rs`, TESORO_MANY_SEAT_FIXTURE): Dee first (60%), Ben second
// (25%), Cy third (15%), Ana refunded 350, Eve aboard at Impact.
const fx: { riders: string[]; events: string[] } = JSON.parse(readFileSync(new URL("./fixtures/many-seat-worked-example.json", import.meta.url), "utf8"));
const [, ben, cy, dee] = fx.riders;

const settleTx = (blockTime: number) => ({
  slot: 1,
  blockTime,
  meta: {
    err: null,
    innerInstructions: [{ index: 0, instructions: fx.events.map((hex) => ({ programIdIndex: 2, accounts: [1], data: anchor.utils.bytes.bs58.encode(Buffer.from(hex, "hex")) })) }],
  },
  transaction: { message: { staticAccountKeys: [Keypair.generate().publicKey, eventAuthority, CORE_ID] } },
});

const winsIn = (tx: ReturnType<typeof settleTx>) => decodeMatchRecords(innerInstructionsOf(tx as any)).filter((r): r is MatchWonRecord => r.type === "won");

describe("a many-seat win in the Season's Points", () => {
  it("counts 5 Points for the last Player off, with the second-last off as the opponent", async () => {
    const [won] = winsIn(settleTx(1_000_100));
    assert.ok(won, "the settle emitted a MatchWon");
    const conn = scriptedConn([{ signature: "ride", tx: settleTx(won.ts) as any }]);
    const wins = await seasonWinsFromChain(conn as any, won.season, won.ts - 10, won.ts + 10);
    assert.deepEqual(wins.map((w) => [w.player, w.loser, w.points]), [[dee, ben, 5]]);
  });

  it("gives second and third place no win and no Points", () => {
    const wins = winsIn(settleTx(1_000_100));
    assert.equal(wins.length, 1);
    const table = standings(wins.map(winOf));
    assert.deepEqual(table.map((s) => [s.account, s.points]), [[dee, 5]]);
    assert.ok(!table.some((s) => s.account === ben || s.account === cy));
  });

  it("caps the last Player off at three Points-earning wins against the same second-last off", () => {
    const [won] = winsIn(settleTx(1_000_100));
    const rides = [0, 1, 2, 3].map((i) => ({ ...winOf(won), ts: won.ts + i * 60, matchId: `${won.opener}-${i}` }));
    assert.deepEqual(cappedWins(rides).map((w) => w.points), [5, 5, 5, 0]);
  });
});
