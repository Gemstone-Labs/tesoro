import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden.json";
import layout from "./chain-layout.json";
import { decodeArmy, decodeBattle, decodeRecord, eventsSince, rankOfCode } from "./decode";

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

describe("event records", () => {
  it.each(golden.events.map((ev, i) => [ev.event.kind + " #" + i, ev] as const))("decodes %s", (_name, ev) => {
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
