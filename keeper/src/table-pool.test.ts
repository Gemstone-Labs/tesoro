import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { GAME_IDS } from "../../app/src/lib/chain/games.ts";
import { poolOf, schedulerSettings, SLOT_FREE, type GameAdapter, type TableRow, type TableView } from "./scheduler.ts";
import { poolPublisher } from "./table-pool.ts";

const view = (index: number, epoch: number, over: Partial<TableView> = {}): TableView => ({
  index,
  epoch,
  coarse: "idle",
  seatsCreated: true,
  seatsOpen: false,
  dirty: false,
  overAt: 0,
  tesoroMatch: Keypair.generate().publicKey,
  ring: [{ state: SLOT_FREE, tesoroMatch: Keypair.generate().publicKey, epoch: 0, at: 0 }],
  raw: null,
  ...over,
});
const row = (index: number, v: TableView | null, base: TableRow["base"] = "delegated"): TableRow => ({ index, base, view: v });

describe("poolOf", () => {
  it("lists idle, seated tables with a free slot, lowest first, with their live epoch", () => {
    const rows = [row(2, view(2, 7)), row(0, view(0, 4)), row(1, view(1, 1, { coarse: "match" })), row(3, null), row(4, view(4, 1), "program")];
    assert.deepEqual(poolOf(rows, [], 6, 1000), [
      { generation: 6, index: 0, epoch: 4 },
      { generation: 6, index: 2, epoch: 7 },
    ]);
  });

  it("leaves out a table an Assignment still holds", () => {
    const rows = [row(0, view(0, 4)), row(1, view(1, 5))];
    assert.deepEqual(poolOf(rows, [{ index: 0, epoch: 4, startDeadline: 2000 }], 6, 1000), [{ generation: 6, index: 1, epoch: 5 }]);
  });
});

describe("KEEPER_ASSIGN", () => {
  it("is on unless turned off", () => {
    assert.equal(schedulerSettings({}).assign, true);
    assert.equal(schedulerSettings({ KEEPER_ASSIGN: "1" }).assign, true);
    assert.equal(schedulerSettings({ KEEPER_ASSIGN: "0" }).assign, false);
    assert.equal(schedulerSettings({ KEEPER_ASSIGN: "off" }).assign, false);
  });
});

describe("poolPublisher", () => {
  it("replaces the Game's rows, keyed by the app's Game id", async () => {
    const calls: [string, unknown][] = [];
    const publish = poolPublisher(async (fn, args) => void calls.push([fn, args]));
    await publish({ programId: GAME_IDS["block-puzzle"] } as GameAdapter, [{ generation: 1, index: 3, epoch: 9 }]);
    assert.deepEqual(calls, [["publish_table_pool", { p_game: "block-puzzle", p_tables: [{ generation: 1, index: 3, epoch: "9" }] }]]);
  });
});
