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

// Core's events from Railcar's own `finalize` transactions, as LiteSVM ran them (programs/railcar/tests/ride.rs,
// `TESORO_RAILCAR_FIXTURE`): riders in boarding order Ana, Ben, Cy, Dee, Eve.
type Ride = { riders: string[]; events: string[] };
const ride = (name: string): Ride => JSON.parse(readFileSync(new URL(`./fixtures/railcar-${name}.json`, import.meta.url), "utf8"));

const finalizeTx = (r: Ride, blockTime = 1_000_100) => ({
  slot: 1,
  blockTime,
  meta: {
    err: null,
    innerInstructions: [{ index: 1, instructions: r.events.map((hex) => ({ programIdIndex: 2, accounts: [1], data: anchor.utils.bytes.bs58.encode(Buffer.from(hex, "hex")) })) }],
  },
  transaction: { message: { staticAccountKeys: [Keypair.generate().publicKey, eventAuthority, CORE_ID] } },
});

const winsIn = (r: Ride) => decodeMatchRecords(innerInstructionsOf(finalizeTx(r) as any)).filter((x): x is MatchWonRecord => x.type === "won");

describe("Railcar in the Season's Points", () => {
  it("counts 5 Points for the last Player off, with the second-last off as the opponent", async () => {
    // the worked example: Ana off first (refunded), then Cy, Ben, Dee; Eve aboard at Impact
    const r = ride("worked-example");
    const [, ben, cy, dee] = r.riders;
    const [won] = winsIn(r);
    assert.ok(won, "finalize emitted core's MatchWon");
    const conn = scriptedConn([{ signature: "ride", tx: finalizeTx(r, won.ts) as any }]);
    const wins = await seasonWinsFromChain(conn as any, won.season, won.ts - 10, won.ts + 10);
    assert.deepEqual(
      wins.map((w) => [w.player, w.loser, w.points]),
      [[dee, ben, 5]],
    );
    const table = standings(wins.map(winOf));
    assert.deepEqual(
      table.map((s) => [s.account, s.points]),
      [[dee, 5]],
    );
    assert.ok(!table.some((s) => s.account === ben || s.account === cy), "places 2 and 3 earn no Points");
  });

  it("caps the last Player off at three Points-earning wins against the same second-last off", () => {
    const [won] = winsIn(ride("worked-example"));
    const rides = [0, 1, 2, 3].map((i) => ({ ...winOf(won), ts: won.ts + i * 60, matchId: `${won.opener}-${i}` }));
    assert.deepEqual(
      cappedWins(rides).map((w) => w.points),
      [5, 5, 5, 0],
    );
  });

  it("with one Player off, names the unplaced seat that lost most as the opponent", () => {
    // Ana alone Jumped; everyone else forfeited 500: the lowest seat of them, Ben, is the opponent
    const r = ride("one-jumper");
    const [ana, ben] = r.riders;
    const wins = winsIn(r);
    assert.deepEqual(
      wins.map((w) => [w.winner, w.loser, w.points]),
      [[ana, ben, 5]],
    );
  });

  it("gives no win and no Points for a ride voided by an outage", () => {
    assert.deepEqual(winsIn(ride("outage")), []);
  });
});
