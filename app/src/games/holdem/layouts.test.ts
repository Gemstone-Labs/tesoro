// Bytes produced by the program's own Rust serializer (`keeper_fixtures` test in programs/holdem writes
// keeper/fixtures/holdem-layouts.json). The app decoders must read them to the values the Rust test wrote.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../../lib/chain/idl/holdem.json";
import { OUTCOME, PHASE, SLOT, STATUS, TABLE_PHASE, canFinalizeTable, decodeAssignment, decodeTable, slotOf, tableOf } from "./chain";

const fixtures = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("../../../../keeper/fixtures/holdem-layouts.json", import.meta.url), "utf8")) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "hex")]),
);
const coder = new Program(idl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
const keyOf = (n: number) => {
  const b = Buffer.alloc(32, n);
  b[0] = (n * 3 + 1) & 0xff;
  return new PublicKey(b);
};

describe("accounts written by holdem", () => {
  it("a table: the table around the Match, the public hand and the ring", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect([t.generation, t.index, t.epoch, t.tablePhase, t.seatsCreated, t.seatsOpen, t.dirty, t.slot]).toEqual([1, 3, 7, TABLE_PHASE.live, true, true, true, 3]);
    expect(t.tesoroMatch.toBase58()).toBe(keyOf(2).toBase58());
    expect([t.startDeadline, t.checkedIn, t.overAt]).toEqual([1300, [true, true], 1151]);
    expect([t.reqNonce, t.reqPending, t.vrfReady]).toEqual([11, false, true]);
    expect(t.players.map((p) => p.toBase58())).toEqual([keyOf(3).toBase58(), keyOf(4).toBase58()]);
    expect([t.speed, t.status, t.winner, t.handNo, t.dealer, t.phase]).toEqual([1, STATUS.live, 255, 3, 0, PHASE.flop]);
    expect([t.smallBlind, t.bigBlind, t.stacks, t.bets, t.committed, t.pot]).toEqual([100n, 200n, [1300n, 1500n], [0n, 200n], [100n, 400n], 500n]);
    expect([t.toAct, t.lastRaise, t.deadline, t.missed]).toEqual([1, 200n, 2000, [0, 1]]);
    expect(t.board).toEqual([11, 18, 33, 255, 255]);
    expect(t.lastHand).toMatchObject({ handNo: 2, result: 2, pot: 1000n, showdown: true, shown: [[51, 49], [12, 25]], board: [1, 2, 3, 4, 5] });
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
    expect([a.generation, a.index, a.epoch, a.speed, a.startDeadline]).toEqual([1, 3, 7, 1, 1300]);
    expect(a.payer.toBase58()).toBe(keyOf(8).toBase58());
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.table));
    expect(tableOf(a, t)).toBe(t);
    expect(tableOf({ ...a, epoch: 6 }, t)).toBeNull();
    const idle = decodeTable(keyOf(1), coder.decode("table", fixtures.idle_table));
    expect(tableOf(a, idle)).toBeNull();
    expect(canFinalizeTable(t, { ...a, tesoroMatch: keyOf(9), epoch: 6 }, 0)).toBe(true);
  });

  it("a seat: its Player, the hand, the cards and the board shares", () => {
    const h = coder.decode("hole", fixtures.hole) as { seat: number; handNo: number; dealt: boolean; contributed: boolean; cards: number[]; shares: number[]; player: PublicKey };
    expect([h.seat, h.handNo, h.dealt, h.contributed, h.cards, h.shares]).toEqual([1, 3, true, true, [51, 49], [1, 2, 3, 4, 5]]);
    expect(h.player.toBase58()).toBe(keyOf(4).toBase58());
  });
});
