// Bytes produced by the program's own Rust serializer (`keeper_fixtures` test in programs/trading_duel writes
// keeper/fixtures/trading-duel-layouts.json). The app decoders must read them to the values the Rust test wrote.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../../lib/chain/idl/trading_duel.json";
import { OUTCOME, PHASE, SLOT, STATUS, decodeAssignment, decodeBook, decodeDuel, decodeTable, slotOf } from "./chain";
import { NO_PICK } from "./grid";

const fixtures = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("../../../../keeper/fixtures/trading-duel-layouts.json", import.meta.url), "utf8")) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "hex")]),
);
const coder = new Program(idl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
const keyOf = (n: number) => {
  const b = Buffer.alloc(32, n);
  b[0] = (n * 3 + 1) & 0xff;
  return new PublicKey(b);
};

describe("accounts written by trading_duel", () => {
  it("a table: epoch, phase, flags, times, the line, revealed picks, scores and the ring", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect([t.generation, t.index, t.epoch, t.phase, t.seatsOpen, t.dirty, t.slot]).toEqual([1, 3, 7, PHASE.live, true, true, 3]);
    expect(t.tesoroMatch.toBase58()).toBe(keyOf(2).toBase58());
    expect(t.players.map((p) => p.toBase58())).toEqual([keyOf(3).toBase58(), keyOf(4).toBase58()]);
    expect([t.asset.symbol, t.startDeadline, t.checkedIn, t.startsAt, t.gridAt, t.endsAt, t.overAt]).toEqual(["ETH", 1300, [true, true], 1000, 1030, 1150, 1151]);
    expect([t.anchor, t.step, t.lastTick]).toEqual([300_000_000_000n, 60_000_000n, 1001]);
    expect(t.track.lo.slice(0, 3)).toEqual([1n, 2n, 3n]);
    expect(t.track.hi[11]).toBe(21n);
    expect(t.track.seen.slice(0, 4)).toEqual([true, false, true, false]);
    expect([t.track.last, t.track.lastCol]).toEqual([305_000_000_000n, 2]);
    expect([t.revealed[0][0], t.revealed[1][0], t.revealed[1][4], t.revealed[0][1]]).toEqual([3, -5, 7, NO_PICK]);
    expect([t.scores, t.winner]).toEqual([[100, 200], 1]);
  });

  it("the ring: a Done result keyed by Match and epoch, and a Reserved slot", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect(t.ring).toHaveLength(8);
    const done = slotOf(t, keyOf(9), 6)!;
    expect([done.state, done.outcome, done.at]).toEqual([SLOT.done, OUTCOME.win1, 1200]);
    expect(slotOf(t, keyOf(9), 7)).toBeNull();
    expect(t.ring[3].state).toBe(SLOT.reserved);
    expect(slotOf(t, keyOf(2), 7)?.state).toBe(SLOT.reserved);
    expect(t.ring[0].state).toBe(SLOT.free);
  });

  it("an idle table has no Match, no picks and an empty ring", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.idle_table));
    expect([t.epoch, t.phase, t.dirty, t.seatsOpen, t.winner]).toEqual([0, PHASE.idle, false, false, 255]);
    expect(t.revealed[0].every((p) => p === NO_PICK)).toBe(true);
    expect(t.ring.every((s) => s.state === SLOT.free)).toBe(true);
  });

  it("an Assignment, and the Duel it picks out of the table", () => {
    const a = decodeAssignment(keyOf(5), coder.decode("assignment", fixtures.assignment));
    expect([a.generation, a.index, a.epoch, a.asset.symbol, a.startDeadline]).toEqual([1, 3, 7, "ETH", 1300]);
    expect(a.payer.toBase58()).toBe(keyOf(8).toBase58());
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    const d = decodeDuel(a, t)!;
    expect([d.status, d.epoch, d.dirty, d.seatsOpen]).toEqual([STATUS.live, 7, true, true]);
    expect(decodeDuel({ ...a, epoch: 8 }, t)).toBeNull();
  });

  it("a Book", () => {
    const b = decodeBook(keyOf(60), coder.decode("book", fixtures.book));
    expect([b.seat, b.pickCount, b.picks[2], b.picks[11], b.picks[0]]).toEqual([1, 2, 6, -3, NO_PICK]);
    expect([b.table.toBase58(), b.player.toBase58()]).toEqual([keyOf(1).toBase58(), keyOf(4).toBase58()]);
  });

  it("the table config", () => {
    const c = coder.decode("tableConfig", fixtures.table_config) as { generation: number; maxTables: number; operator: PublicKey };
    expect([c.generation, c.maxTables, c.operator.toBase58()]).toEqual([1, 4, keyOf(5).toBase58()]);
  });
});
