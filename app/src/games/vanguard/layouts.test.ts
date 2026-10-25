// Bytes produced by the program's own Rust serializer (`keeper_fixtures` test in programs/vanguard writes
// keeper/fixtures/vanguard-layouts.json). The app decoders must read them to the values the Rust test wrote.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../../lib/chain/idl/vanguard.json";
import { OUTCOME, SLOT, TABLE_PHASE, canFinalizeTable, decodeAssignment, decodeTable, slotOf, tableOf } from "./chain";
import { decodeArmy } from "./decode";

const fixtures = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("../../../../keeper/fixtures/vanguard-layouts.json", import.meta.url), "utf8")) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "hex")]),
);
const coder = new Program(idl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
const keyOf = (n: number) => {
  const b = Buffer.alloc(32, n);
  b[0] = (n * 3 + 1) & 0xff;
  return new PublicKey(b);
};

describe("accounts written by vanguard", () => {
  it("a table: the protocol around the Match and the request state", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect([t.generation, t.index, t.epoch, t.phase, t.seatsCreated, t.seatsOpen, t.dirty, t.slot]).toEqual([1, 3, 7, TABLE_PHASE.live, true, true, true, 3]);
    expect(t.tesoroMatch.toBase58()).toBe(keyOf(2).toBase58());
    expect([t.startDeadline, t.checkedIn, t.overAt]).toEqual([1300, [true, true], 1151]);
    expect([t.reqNonce, t.reqPending, t.reqMade, t.vrfReady]).toEqual([11, false, true, true]);
  });

  it("the ring: a Done result keyed by Match and epoch, and a Reserved slot", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect(t.ring).toHaveLength(8);
    const done = slotOf(t, keyOf(9), 6)!;
    expect([done.state, done.outcome, done.at]).toEqual([SLOT.done, OUTCOME.win1, 1200]);
    expect(slotOf(t, keyOf(2), 7)!.state).toBe(SLOT.reserved);
    expect(slotOf(t, keyOf(9), 7)).toBeNull();
  });

  it("an Assignment, and whether a table is on its Match and epoch", () => {
    const a = decodeAssignment(keyOf(6), coder.decode("assignment", fixtures.assignment));
    expect([a.generation, a.index, a.epoch, a.startDeadline]).toEqual([1, 3, 7, 1300]);
    expect(a.payer.toBase58()).toBe(keyOf(8).toBase58());
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect(tableOf(a, t)).toBe(true);
    expect(tableOf({ ...a, epoch: 6 }, t)).toBe(false);
    const idle = decodeTable(keyOf(1), coder.decode("table", fixtures.idle_table));
    expect(tableOf(a, idle)).toBe(false);
    expect(canFinalizeTable(t, { ...a, tesoroMatch: keyOf(9), epoch: 6 }, 0)).toBe(true);
  });

  it("a seat: the byte decoder and the IDL agree, and a waiting seat shows only that its secret is in", () => {
    const idlArmy = coder.decode("army", fixtures.army_waiting) as { seat: number; player: PublicKey; contributed: boolean; dealt: boolean };
    const army = decodeArmy(new Uint8Array(fixtures.army_waiting));
    expect([army.seat, army.contributed, army.dealt, army.side]).toEqual([idlArmy.seat, true, false, 255]);
    expect(army.player.toBase58()).toBe(keyOf(4).toBase58());
    expect(army.table.toBase58()).toBe(keyOf(1).toBase58());
    expect(army.sealKey).toEqual(new Uint8Array(32));
  });

  it("a dealt seat: ranks, the sealing key and the storm share", () => {
    const army = decodeArmy(new Uint8Array(fixtures.army_dealt));
    expect([army.side, army.ranks[0], army.dealt, army.contributed]).toEqual([0, 7, true, false]);
    expect([...army.sealKey]).toEqual(Array(32).fill(0xa0));
    const raw = coder.decode("army", fixtures.army_dealt) as { stormAt: number; stormSeed: number };
    expect([raw.stormAt, raw.stormSeed]).toEqual([0x0a0b, 0x0c0d0e0f]);
  });

  it("the table settings", () => {
    const c = coder.decode("tableConfig", fixtures.table_config) as { operator: PublicKey; generation: number; maxTables: number };
    expect([c.generation, c.maxTables, c.operator.toBase58()]).toEqual([1, 4, keyOf(5).toBase58()]);
  });
});
