import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden.json";
import layout from "./chain-layout.json";
import { CODE_DUG_IN, CODE_SWITCHED, PENDING, changeOfCode, dealtRankOfCode, decodeArmy, decodeBattle, decodeRecord, eventsSince, rankOfCode } from "./decode";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (b: Uint8Array | { toBuffer(): Buffer }) => Buffer.from("toBuffer" in b ? b.toBuffer() : b).toString("hex");

describe("the Battle decoder against account bytes the Rust program wrote", () => {
  const e = golden.battle.expected;
  const b = decodeBattle(bytes(golden.battle.bytes));

  it("reads every scalar field", () => {
    expect(b.matchId.toString()).toBe(e.matchId);
    expect(b.moved.toString()).toBe(e.moved);
    expect([b.startDeadline, b.entropyDeadline, b.deadline, b.startedAt]).toEqual([e.startDeadline, e.entropyDeadline, e.deadline, e.startedAt]);
    expect([b.eventSeq, b.turnNo, b.moves]).toEqual([e.eventSeq, e.turnNo, e.moves]);
    expect([b.bump, b.authorityBump, b.usSeat, b.status, b.finalized, b.permissioned, b.winner, b.reason, b.turn, b.stepsLeft, b.twoStepActive, b.stormDone]).toEqual([
      e.bump, e.authorityBump, e.usSeat, e.status, e.finalized, e.permissioned, e.winner, e.reason, e.turn, e.stepsLeft, e.twoStepActive, e.stormDone,
    ]);
    expect([b.twoStep, b.timeouts, b.depotClaimed]).toEqual([e.twoStep, e.timeouts, e.depotClaimed]);
  });

  it("reads the stored rules, the setup deadline and the pending action", () => {
    expect([b.layoutVersion, b.rulesVersion, b.setupDeadline, b.capDeadline]).toEqual([e.layoutVersion, e.rulesVersion, e.setupDeadline, e.capDeadline]);
    expect([b.moveCap, b.capSecs, b.turnSecs, b.graceSecs, b.openingGraceSecs, b.resolveSlackSecs, b.stormFrom, b.stormTo]).toEqual([
      e.moveCap, e.capSecs, e.turnSecs, e.graceSecs, e.openingGraceSecs, e.resolveSlackSecs, e.stormFrom, e.stormTo,
    ]);
    expect([b.pendingKind, b.pendingPiece, b.pendingTo, b.pendingSeat, b.actionSeq, b.pendingTime]).toEqual([
      e.pendingKind, e.pendingPiece, e.pendingTo, e.pendingSeat, e.actionSeq, e.pendingTime,
    ]);
    expect([b.pendingSlot.toString(), b.dealSlot.toString()]).toEqual([e.pendingSlot, e.dealSlot]);
    expect([hexOf(b.payer), hexOf(b.oracleQueue)]).toEqual([e.payer, e.oracleQueue]);
    expect(b.pendingKind).toBe(PENDING.move);
  });

  it("reads the keys, the 60 piece slots and the trails", () => {
    expect(hexOf(b.tesoroMatch)).toBe(e.tesoroMatch);
    expect(b.players.map(hexOf)).toEqual(e.players);
    expect(hexOf(Uint8Array.from(b.sq))).toBe(e.sq);
    expect(hexOf(Uint8Array.from(b.shown))).toBe(e.shown);
    expect(hexOf(Uint8Array.from(b.trailLen))).toBe(e.trailLen);
    expect(b.trail.map((t) => hexOf(Uint8Array.from(t)))).toEqual(e.trail);
  });

  it("reads the 16 ring slots", () => {
    expect(b.ring.map((r) => ({ seq: r.seq, kind: r.kind, data: hexOf(Uint8Array.from(r.data)) }))).toEqual(e.ring);
  });

  it("refuses bytes of the wrong length or kind of account", () => {
    expect(() => decodeBattle(bytes(golden.battle.bytes).slice(0, 100))).toThrow();
    expect(() => decodeBattle(bytes(golden.army.bytes))).toThrow();
  });

  it("is driven by the generated offsets table", () => {
    expect(layout.battle.size).toBe(bytes(golden.battle.bytes).length);
    expect(layout.battle.offsets.sq + layout.battle.pieceSlots).toBe(layout.battle.offsets.shown);
  });
});

describe("the Army decoder", () => {
  it("reads the private ranks, the fuel and the Truck turn", () => {
    const e = golden.army.expected;
    const a = decodeArmy(bytes(golden.army.bytes));
    expect([a.bump, a.seat, a.side, a.fuel, a.truckTurn, a.moves]).toEqual([e.bump, e.seat, e.side, e.fuel, e.truckTurn, e.moves]);
    expect(hexOf(a.battle)).toBe(e.battle);
    expect(hexOf(a.player)).toBe(e.player);
    expect(hexOf(Uint8Array.from(a.ranks))).toBe(e.ranks);
  });
});

// Rust-written records of the powers (kinds 8-12); the chain client ticket teaches the decoder and drops this filter.
const POWER_EVENTS = ["blast", "rescue", "dug_in", "pass", "switched"];

describe("event records", () => {
  it.each(golden.events.filter((ev) => !POWER_EVENTS.includes(ev.event.kind)).map((ev, i) => [ev.event.kind + " #" + i, ev] as const))("decodes %s", (_name, ev) => {
    const raw = bytes(ev.bytes);
    const rec = { seq: new DataView(raw.buffer, raw.byteOffset).getUint32(0, true), kind: raw[4], data: Array.from(raw.slice(5, 40)) };
    expect(rec.seq).toBe(ev.seq);
    expect(decodeRecord(rec)).toEqual({ ...ev.event, seq: ev.seq });
  });

  it("plays only the records newer than the cursor, in order", () => {
    const b = decodeBattle(bytes(golden.battle.bytes));
    // eventSeq 21: the ring holds seq 5..20
    expect(eventsSince(b, 5)).toMatchObject({ kind: "events", events: [...Array(16).keys()].map((i) => expect.objectContaining({ seq: i + 5 })) });
    const some = eventsSince(b, 18);
    expect(some.kind === "events" && some.events.map((x) => x.seq)).toEqual([18, 19, 20]);
    expect(eventsSince(b, 21)).toEqual({ kind: "events", events: [] });
  });

  it("snaps to the board when the client fell more than the ring behind", () => {
    const b = decodeBattle(bytes(golden.battle.bytes));
    expect(eventsSince(b, 4).kind).toBe("snap");
    expect(eventsSince(b, 0).kind).toBe("snap");
  });
});

describe("rank codes", () => {
  it("maps the program's codes to the app's ranks", () => {
    expect([1, 2, 10, 11, 12].map(rankOfCode)).toEqual(["1", "2", "10", "B", "F"]);
    expect(rankOfCode(0)).toBeNull();
  });
});

describe("rank codes of the powers", () => {
  it("reads a dug-in Major as a Landmine and a switched General of the Army as a Spy, and remembers what they were", () => {
    expect(rankOfCode(CODE_DUG_IN)).toBe("B");
    expect(rankOfCode(CODE_SWITCHED)).toBe("1");
    expect(dealtRankOfCode(CODE_DUG_IN)).toBe("7");
    expect(dealtRankOfCode(CODE_SWITCHED)).toBe("10");
    expect(dealtRankOfCode(5)).toBe("5");
    expect([CODE_DUG_IN, CODE_SWITCHED, 7, 10, 0].map(changeOfCode)).toEqual(["dug", "spy", null, null, null]);
    expect(CODE_DUG_IN).toBe(13);
    expect(CODE_SWITCHED).toBe(14);
  });
});

describe("the account tails the layout table does not name", () => {
  const battleBytes = () => bytes(golden.battle.bytes).slice();
  const armyBytes = () => bytes(golden.army.bytes).slice();

  it("puts the sealing key in the last 32 bytes of the Army, after the move counter, and the end mask in the Battle's last 31", () => {
    // the Rust offsets test pins Battle.reserved at 8 + 1481 and the Army is Borsh with `reserved: [u8; 32]` last
    expect(layout.army.offsets.moves + 2).toBe(layout.army.size - 32);
    expect(layout.battle.offsets.resolveSlackSecs + 1).toBe(layout.battle.size - 31);
  });

  it("decodes the Army key and keeps the ranks and counters it had", () => {
    const raw = armyBytes();
    for (let i = 0; i < 32; i++) raw[layout.army.size - 32 + i] = 0xa0 + i;
    const a = decodeArmy(raw);
    expect(Array.from(a.sealKey)).toEqual(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
    expect(a.moves).toBe(golden.army.expected.moves);
    expect(hexOf(Uint8Array.from(a.ranks))).toBe(golden.army.expected.ranks);
    expect(Array.from(decodeArmy(armyBytes()).sealKey)).toEqual(Array(32).fill(0)); // wiped: no key
  });

  it("decodes the private rank codes of a dug-in Major and a switched General in the owner's Army", () => {
    const raw = armyBytes();
    raw[layout.army.offsets.ranks + 3] = CODE_DUG_IN;
    raw[layout.army.offsets.ranks + 12] = CODE_SWITCHED;
    const a = decodeArmy(raw);
    expect([a.ranks[3], a.ranks[12]]).toEqual([13, 14]);
  });

  it("decodes the end mask as a little-endian u64, bit = piece id, and it is zero before the Match ends", () => {
    const raw = battleBytes();
    expect(decodeBattle(raw).endMask).toBe(0n);
    const at = layout.battle.size - 31;
    const mask = (1n << 5n) | (1n << 41n) | (1n << 59n);
    new DataView(raw.buffer, raw.byteOffset).setBigUint64(at, mask, true);
    expect(decodeBattle(raw).endMask).toBe(mask);
    // the 31st reserved byte the mask does not use stays out of it
    raw[layout.battle.size - 1] = 0xff;
    expect(decodeBattle(raw).endMask).toBe(mask);
  });

  it("names the new pending kinds", () => {
    expect(PENDING).toMatchObject({ move: 1, timeout: 2, cap: 3, blast: 4, rescue: 5, pass: 6 });
    const raw = battleBytes();
    raw[layout.battle.offsets.pendingKind] = 6;
    raw[layout.battle.offsets.pendingPiece] = 0x9c; // a pass's piece byte is the sealed Dig in slot
    expect(decodeBattle(raw)).toMatchObject({ pendingKind: PENDING.pass, pendingPiece: 0x9c });
  });
});

describe("the events of the powers (record kinds 8-12)", () => {
  const rec = (kind: number, data: number[], seq = 40) => ({ seq, kind, data: [...data, ...Array(35 - data.length).fill(0)] });
  const sq = (r: number, c: number) => ({ r, c });

  it("decodes a Blast: the Engineer, its square and the (piece, rank) pairs it showed", () => {
    expect(decodeRecord(rec(8, [33, 54, 3, 20, 7, 21, 11, 22, 12]))).toEqual({
      seq: 40, kind: "blast", id: 33, at: sq(5, 4), shown: [{ id: 20, rank: "7" }, { id: 21, rank: "B" }, { id: 22, rank: "F" }],
    });
    expect(decodeRecord(rec(8, [33, 54, 0]))).toMatchObject({ kind: "blast", shown: [] });
  });

  it("decodes a Blast showing all eight neighbours", () => {
    const pairs = Array.from({ length: 8 }, (_, i) => [10 + i, i + 1]).flat();
    const e = decodeRecord(rec(8, [33, 54, 8, ...pairs]));
    expect(e && e.kind === "blast" && e.shown.map((s) => s.rank)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("decodes a Rescue: the Colonel, the Truck and the two squares", () => {
    expect(decodeRecord(rec(9, [44, 31, 12, 66]))).toEqual({ seq: 40, kind: "rescue", colonel: 44, truck: 31, from: sq(1, 2), to: sq(6, 6) });
  });

  it("decodes a face-up Major's Dig in, a pass, and a face-up General's switch", () => {
    expect(decodeRecord(rec(10, [1, 37]))).toEqual({ seq: 40, kind: "dug_in", army: "it", id: 37 });
    expect(decodeRecord(rec(10, [0, 37]))).toMatchObject({ army: "us" });
    expect(decodeRecord(rec(11, [0]))).toEqual({ seq: 40, kind: "pass", army: "us" });
    expect(decodeRecord(rec(11, [1]))).toEqual({ seq: 40, kind: "pass", army: "it" });
    expect(decodeRecord(rec(12, [55]))).toEqual({ seq: 40, kind: "switched", id: 55 });
  });

  it("still decodes the old kinds, and a kind it does not know is skipped", () => {
    expect(decodeRecord(rec(1, [41, 63, 53]))).toMatchObject({ kind: "move", id: 41 });
    expect(decodeRecord(rec(6, [1, 1]))).toEqual({ seq: 40, kind: "turn", turn: "it", timedOut: true });
    expect(decodeRecord(rec(2, [1, 2, 3, 4, 4, 255, 255]))).toMatchObject({ outcome: "defuse" }); // v5 history
    expect(decodeRecord(rec(99, [1]))).toBeNull();
  });

  it("a ring holding the new kinds plays in order, and a refused action is a timed-out turn", () => {
    const b = decodeBattle(bytes(golden.battle.bytes));
    const ring = b.ring.map((r) => ({ ...r }));
    const put = (seq: number, kind: number, data: number[]) => (ring[seq % 16] = rec(kind, data, seq));
    put(19, 11, [0]);
    put(20, 6, [1, 0]);
    const events = eventsSince({ ...b, ring, eventSeq: 21 }, 19);
    expect(events).toMatchObject({ kind: "events", events: [{ kind: "pass" }, { kind: "turn", turn: "it", timedOut: false }] });
  });
});
