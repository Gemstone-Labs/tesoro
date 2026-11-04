import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import type { CarView } from "../../lib/chain/many-seat-plan";
import { COMMIT_RETRY_SECS, DRAW_WINDOW_SLOTS, PHASE, RIDE_CAP_SECS, TABLE_AT, nextRideStep, type Ride, type TableView } from "./chain";

const T0 = 1_800_000_000;
const coreCar = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

const car = (over: Partial<CarView> = {}): CarView => ({ address: coreCar, stage: "departed", refundAfter: T0 + 86_400, departedAt: T0 - 900, ...over }) as CarView;
const table = (over: Partial<TableView> = {}): TableView => ({ phase: PHASE.riding, tesoroMatch: coreCar, carNo: 7n, nextCar: 9n, startedSlot: 1_000n, rideTs: T0 - 800, dirty: false, commitAt: 0, ...over }) as TableView;
const ride = (t: Partial<TableView> = {}, over: Partial<Ride> = {}): Ride => ({ carNo: 7n, car: { carNo: 7n } as Ride["car"], table: table(t), baseTable: null, previousFrozen: true, ...over });
const step = (r: Ride | null, o: { car?: Partial<CarView>; slot?: bigint; now?: number } = {}) => nextRideStep({ coreCar: car(o.car), ride: r, slot: o.slot ?? 1_000_000n, now: o.now ?? T0 });

describe("the step an unfinished Railcar ride needs", () => {
  it("sends a car that never left on its way, and leaves a settling car to the finisher", () => {
    expect(step(null, { car: { stage: "boarding" } })).toEqual({ step: "check_departure" });
    expect(step(ride(), { car: { stage: "settling" } })).toEqual({ wait: "the car is settling" });
  });

  it("starts a ride nobody started once its Table is free, and waits while an earlier car holds it", () => {
    const waiting = { phase: PHASE.idle, tesoroMatch: other, nextCar: 7n };
    expect(step(ride(waiting))).toEqual({ step: "start_ride" });
    expect(step(ride({ ...waiting, phase: PHASE.over }, { previousFrozen: false }))).toEqual({ wait: "the Table's previous car is not frozen yet" });
    expect(step(ride({ ...waiting, nextCar: 5n }))).toEqual({ wait: "an earlier car still holds the Table" });
    expect(step(null)).toEqual({ wait: "an earlier car still holds the Table" });
  });

  it("voids a draw that never came only once its window is over", () => {
    const drawing = { phase: PHASE.drawing, startedSlot: 1_000n };
    expect(step(ride(drawing), { slot: 1_000n + BigInt(DRAW_WINDOW_SLOTS) })).toEqual({ wait: "the draw window is open" });
    expect(step(ride(drawing), { slot: 1_001n + BigInt(DRAW_WINDOW_SLOTS) })).toEqual({ step: "signal" });
  });

  it("signals a riding Table, and counts on it only once the ride cap is over", () => {
    expect(step(ride({ rideTs: T0 - 60 }))).toEqual({ step: "signal_then_check" });
    expect(step(ride({ rideTs: T0 - RIDE_CAP_SECS }))).toEqual({ step: "signal" });
  });

  it("commits a result base does not hold, then finalizes once base holds it", () => {
    expect(step(ride({ phase: PHASE.over, dirty: true }))).toEqual({ step: "commit_table" });
    expect(step(ride({ phase: PHASE.over, commitAt: T0 - 10 }))).toEqual({ wait: "the commit is on its way to base" });
    expect(step(ride({ phase: PHASE.over, commitAt: T0 - COMMIT_RETRY_SECS }))).toEqual({ step: "commit_table" });
    const over = table({ phase: PHASE.over });
    expect(step(ride({ phase: PHASE.over }, { baseTable: over }))).toEqual({ step: "finalize" });
    // base still shows the Table's previous ride: wait for the commit, and send it again once it may have been lost
    const stale = { baseTable: table({ phase: PHASE.over, carNo: 5n, tesoroMatch: other }) };
    expect(step(ride({ phase: PHASE.over, commitAt: T0 - 10 }, stale))).toEqual({ wait: "the commit is on its way to base" });
    expect(step(ride({ phase: PHASE.over, commitAt: T0 - COMMIT_RETRY_SECS }, stale))).toEqual({ step: "commit_table" });
  });

  it("refunds through core after 24 h unless base already holds the result", () => {
    const late = { now: T0 + 86_400, car: { refundAfter: T0 + 86_400 } };
    expect(step(ride(), late)).toEqual({ step: "refund" });
    expect(step(null, late)).toEqual({ step: "refund" });
    expect(step(ride({ phase: PHASE.over }, { baseTable: table({ phase: PHASE.over }) }), late)).toEqual({ step: "finalize" });
  });
});

describe("the Table's layout", () => {
  /** Byte offsets of the Table's fields after the discriminator, from the IDL (byte arrays and u8s only). */
  const offsets = () => {
    const types = (railcarIdl as { types: { name: string; type: { fields: { name: string; type: unknown }[] } }[] }).types;
    const size = (t: unknown): number => {
      if (t === "u8") return 1;
      const arr = (t as { array?: [unknown, number] }).array;
      if (arr) return size(arr[0]) * arr[1];
      const def = (t as { defined?: { name: string } }).defined;
      if (def) return types.find((x) => x.name === def.name)!.type.fields.reduce((a, f) => a + size(f.type), 0);
      throw new Error(`unexpected type ${JSON.stringify(t)}`);
    };
    const out: Record<string, number> = {};
    let at = 0;
    for (const f of types.find((x) => x.name === "Table")!.type.fields) {
      out[f.name] = at;
      at += size(f.type);
    }
    return out;
  };

  it("is read where the program writes it", () => {
    const o = offsets();
    const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const [k, at] of Object.entries(TABLE_AT)) expect([k, o[snake(k)]]).toEqual([k, at]);
  });

  it("is the program the IDL names", () => {
    expect(new PublicKey((railcarIdl as { address: string }).address).toBase58()).toBe("DJkNxkAogb32VQm1TQMSVCbzHcaV3SDBy5kBmpqaNHxC");
  });
});
