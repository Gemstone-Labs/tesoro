// Bytes produced by the program's own Rust serializer (`keeper_fixtures` test in programs/block_puzzle writes
// keeper/fixtures/block-puzzle-layouts.json). The live client's decoders must read them to the values the Rust test wrote.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../../lib/chain/idl/block_puzzle.json";
import {
  OUTCOME,
  REASON,
  SLOT,
  TABLE_PHASE,
  canFinalizeTable,
  canPlayPublic,
  decodeAssignment,
  decodeBoard,
  decodeTable,
  offsetsOf,
  paceLimit,
  phaseAt,
  rebuildRun,
  runLogOf,
  scoresHidden,
  secondsLeft,
  slotOf,
  tableOf,
  unpackMove,
  packMove,
} from "./live-chain";

const fixtures = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("../../../../keeper/fixtures/block-puzzle-layouts.json", import.meta.url), "utf8")) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "hex")]),
);
const coder = new Program(idl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
const keyOf = (n: number) => {
  const b = Buffer.alloc(32, n);
  b[0] = (n * 3 + 1) & 0xff;
  return new PublicKey(b);
};
const table = () => decodeTable(keyOf(1), coder.decode("table", fixtures.table));

describe("accounts written by block_puzzle", () => {
  it("a table: the Match, its clock, what each seat shows", () => {
    const t = table();
    expect([t.generation, t.index, t.epoch, t.phase, t.seatsCreated, t.seatsOpen, t.dirty, t.slot]).toEqual([1, 3, 7, TABLE_PHASE.getReady, true, true, false, 3]);
    expect(t.tesoroMatch.toBase58()).toBe(keyOf(2).toBase58());
    expect(t.players.map((p) => p.toBase58())).toEqual([keyOf(3).toBase58(), keyOf(4).toBase58()]);
    expect([t.checkedIn, t.assignedSlot, t.assignedTs, t.seedingSlot]).toEqual([[true, true], 50000, 1000, 50400]);
    expect([t.reqNonce, t.reqPending, t.reqCount, t.seedReady, t.readySlot, t.startSlot]).toEqual([11, false, 1, true, 50900, 51900]);
    expect([t.shownScore, t.shownMoves]).toEqual([[37, 12], [14, 6]]);
    expect(t.ring).toHaveLength(8);
    expect(t.logs).toHaveLength(8);
  });

  it("the ring: a Done result keyed by Match and epoch with its run log", () => {
    const t = table();
    const done = slotOf(t, keyOf(9), 6)!;
    expect([done.state, done.outcome, done.at]).toEqual([SLOT.done, OUTCOME.win1, 1200]);
    expect(slotOf(t, keyOf(2), 7)!.state).toBe(SLOT.reserved);
    expect(slotOf(t, keyOf(9), 7)).toBeNull();
    const log = runLogOf(t, keyOf(9), 6)!;
    expect([log.engineVersion, log.seed, log.startSlot, log.reason, log.scores, log.counts]).toEqual([1, 0x1122334455667788n, 40000, REASON.played, [18, 77], [3, 4]]);
    expect(log.moves[0]).toBe(0b01010011);
    expect(log.moves[120]).toBe(0b10111000);
    expect(offsetsOf(log.offsets, 0, 1)).toEqual([0x012c]);
    expect(offsetsOf(log.offsets, 1, 1)).toEqual([0x1f90]);
    expect(runLogOf(t, keyOf(2), 7)).toBeNull();
  });

  it("an Assignment, and whether a table is on its Match and epoch", () => {
    const a = decodeAssignment(keyOf(6), coder.decode("assignment", fixtures.assignment));
    expect([a.generation, a.index, a.epoch, a.startDeadline]).toEqual([1, 3, 7, 1300]);
    const t = table();
    expect(tableOf(a, t)).toBe(t);
    expect(tableOf({ ...a, epoch: 6 }, t)).toBeNull();
    expect(tableOf(a, decodeTable(keyOf(1), coder.decode("table", fixtures.idle_table)))).toBeNull();
    expect(canFinalizeTable(t, { ...a, tesoroMatch: keyOf(9), epoch: 6 }, 0)).toBe(true);
  });

  it("a closed table carries the reason and outcome", () => {
    const t = decodeTable(keyOf(1), coder.decode("table", fixtures.closed_table));
    expect([t.phase, t.dirty, t.reason, t.outcome]).toEqual([TABLE_PHASE.closed, true, REASON.absent, OUTCOME.win0]);
  });

  it("a Board: the Player's run", () => {
    const b = decodeBoard(coder.decode("board", fixtures.board));
    expect([b.seat, b.epoch, b.began, b.seed, b.score, b.moves, b.used, b.over]).toEqual([1, 7, true, 0x1122334455667788n, 77, 4, 1, false]);
    expect(b.player.toBase58()).toBe(keyOf(4).toBase58());
  });

  it("the Vault has no player and holds the Seed", () => {
    const v = coder.decode("vault", fixtures.vault) as { ready: boolean; seed: { toString(): string } };
    expect([v.ready, BigInt(v.seed.toString())]).toEqual([true, 0x1122334455667788n]);
  });
});

describe("the clock, from the table and the rollup slot", () => {
  const t = () => table(); // startSlot 51900
  it("get-ready, running, frozen, grace, ended", () => {
    const s = t().startSlot;
    expect(phaseAt(t(), s - 1)).toBe("getReady");
    expect(phaseAt(t(), s)).toBe("running");
    expect(phaseAt(t(), s + 7999)).toBe("running");
    expect(phaseAt(t(), s + 8000)).toBe("frozen");
    expect(phaseAt(t(), s + 8999)).toBe("frozen");
    expect(phaseAt(t(), s + 9000)).toBe("grace");
    expect(phaseAt(t(), s + 9300)).toBe("grace");
    expect(phaseAt(t(), s + 9301)).toBe("ended");
  });
  it("public play until the freeze, scores hidden from it", () => {
    const s = t().startSlot;
    expect(canPlayPublic(t(), s + 7999)).toBe(true);
    expect(canPlayPublic(t(), s + 8000)).toBe(false);
    expect(scoresHidden(t(), s + 7999)).toBe(false);
    expect(scoresHidden(t(), s + 8000)).toBe(true);
    expect(scoresHidden(t(), s + 9301)).toBe(true);
  });
  it("seconds left, and the pace the program allows", () => {
    const s = t().startSlot;
    expect(secondsLeft(t(), s)).toBe(90);
    expect(secondsLeft(t(), s + 4500)).toBe(45);
    expect(secondsLeft(t(), s + 9500)).toBe(0);
    expect(paceLimit(t(), s)).toBe(6);
    expect(paceLimit(t(), s + 100)).toBe(10);
  });
  it("the check-in and seed windows end in slots", () => {
    const base = { ...t(), phase: TABLE_PHASE.assigned, assignedSlot: 1000 };
    expect(phaseAt(base, 7000)).toBe("checkIn");
    expect(phaseAt(base, 7001)).toBe("ended");
    const seeding = { ...t(), phase: TABLE_PHASE.seeding, seedingSlot: 1000 };
    expect(phaseAt(seeding, 7000)).toBe("seeding");
    expect(phaseAt(seeding, 7001)).toBe("ended");
  });
});

describe("the move codec and the reconnect", () => {
  it("packs the place in the hand, x and y, and unpacks with the move count", () => {
    expect(packMove(3, { piece: 5, x: 6, y: 2 })).toBe(0b10110010);
    expect(unpackMove(4, 0b10110010)).toEqual({ piece: 5, x: 6, y: 2 });
    expect(unpackMove(0, 0)).toEqual({ piece: 0, x: 0, y: 0 });
  });
  it("Seed + log rebuilds the state a Rust run produced (an empty log is the fresh state)", () => {
    const st = rebuildRun(42n, new Uint8Array(120), 0);
    expect([st.score, st.moves, st.occ, st.over]).toEqual([0, 0, 0n, false]);
  });
});
