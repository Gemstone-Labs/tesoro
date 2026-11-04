import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { CarView, SeatPageView, SeatView } from "../../lib/chain/many-seat";
import type { TableView } from "./chain";
import { boardingSteps, departureDue, mayFinish, nextRideStep, queueChoice, signalIntervalMs } from "./flow";

const key = () => Keypair.generate().publicKey;
const T0 = 1_762_300_000;

const coreCar = (o: Partial<CarView> = {}): CarView =>
  ({ address: key(), payer: key(), opener: key(), n: 0n, game: key(), settleAuthority: key(), studioOwner: null, entry: 500n, openedAt: T0, deadlineAbs: T0 + 7 * 86_400, minSince: 0, firstMinAt: 0, departedAt: 0, platformBps: 200, studioBps: 300, listed: true, minSeats: 5, maxSeats: 100, seated: 0, pages: 0, stage: "boarding", refundAfter: 0, run: {} as CarView["run"], ...o }) as CarView;
const seat = (index: number, seated = true): SeatView => ({ index, seated, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: key(), funder: key(), pot: key() });
const page = (index: number, seatedCount: number): SeatPageView => ({ index, matchKey: key(), payer: key(), seats: Array.from({ length: 10 }, (_, i) => seat(index * 10 + i, i < seatedCount)) });
const config = (o: Partial<{ nextCar: bigint; boardingMatch: PublicKey }> = {}) => ({ operator: key(), tables: 2, nextCar: 4n, boardingMatch: PublicKey.default, ...o });

describe("the Railcar Queue: which car a Player boards", () => {
  it("boards the car that is boarding, on the first page with room", () => {
    const car = coreCar({ seated: 13, pages: 2 });
    const c = queueChoice({ config: config({ nextCar: 4n, boardingMatch: car.address }), boarding: { car, carNo: 3n, pages: [page(0, 10), page(1, 3)] }, now: T0 + 5, mine: false });
    expect(c).toEqual({ kind: "join", car: car.address, carNo: 3n, page: 1 });
  });

  it("opens the next car when none is boarding", () => {
    expect(queueChoice({ config: config({ nextCar: 0n }), boarding: null, now: T0, mine: false })).toEqual({ kind: "open", carNo: 0n, departFirst: null });
    const gone = coreCar({ stage: "departed", seated: 7, pages: 1 });
    expect(queueChoice({ config: config({ nextCar: 5n, boardingMatch: gone.address }), boarding: { car: gone, carNo: 4n, pages: [page(0, 7)] }, now: T0, mine: false })).toEqual({ kind: "open", carNo: 5n, departFirst: null });
  });

  it("the 101st Player: the full car leaves in the same transaction and the Player opens the next one", () => {
    const full = coreCar({ seated: 100, pages: 10 });
    const c = queueChoice({ config: config({ nextCar: 8n, boardingMatch: full.address }), boarding: { car: full, carNo: 7n, pages: Array.from({ length: 10 }, (_, p) => page(p, 10)) }, now: T0, mine: false });
    expect(c).toEqual({ kind: "open", carNo: 8n, departFirst: { car: full.address, carNo: 7n } });
  });

  it("a car past its boarding hour takes nobody: the next car opens", () => {
    const old = coreCar({ seated: 2, pages: 1, deadlineAbs: T0 + 3_600 });
    expect(queueChoice({ config: config({ nextCar: 9n, boardingMatch: old.address }), boarding: { car: old, carNo: 8n, pages: [page(0, 2)] }, now: T0, mine: false }).kind).toBe("open");
  });

  it("a Player already aboard the boarding car goes back to it", () => {
    const car = coreCar({ seated: 6, pages: 1 });
    expect(queueChoice({ config: config({ boardingMatch: car.address }), boarding: { car, carNo: 3n, pages: [page(0, 6)] }, now: T0, mine: true })).toEqual({ kind: "seated", car: car.address, carNo: 3n });
  });

  it("an Offer whose Backer already has a seat in this car waits for the next car", () => {
    const car = coreCar({ seated: 6, pages: 1 });
    expect(queueChoice({ config: config({ boardingMatch: car.address }), boarding: { car, carNo: 3n, pages: [page(0, 6)] }, now: T0, mine: false, backerSeated: true }).kind).toBe("backer-seated");
  });

  it("an entry too long for one transaction is staged in an Entry Ticket before boarding", () => {
    expect(boardingSteps(false)).toEqual(["board"]);
    expect(boardingSteps(true)).toEqual(["stage-ticket", "board"]);
  });
});

describe("departure", () => {
  it("waits with no limit below 5, counts 30 s from the first time 5 boarded, and never restarts", () => {
    expect(departureDue(coreCar({ seated: 4 }), T0 + 1_000)).toBe(false);
    const five = coreCar({ seated: 5, firstMinAt: T0 + 10, minSince: T0 + 10 });
    expect(departureDue(five, T0 + 39)).toBe(false);
    expect(departureDue(five, T0 + 40)).toBe(true);
    // Someone stepped off and back on: the end time is still 30 s after the first 5th.
    expect(departureDue({ ...five, minSince: T0 + 35 }, T0 + 40)).toBe(true);
    // Below 5 at the end time: the car waits, then leaves the moment a 5th boards.
    expect(departureDue({ ...five, seated: 4, minSince: 0 }, T0 + 60)).toBe(false);
  });

  it("leaves at once when it holds 100", () => {
    expect(departureDue(coreCar({ seated: 100, firstMinAt: T0 + 50 }), T0 + 51)).toBe(true);
  });
});

describe("signals", () => {
  it("open pages share about 5 signals a second: each page waits longer the more Players are aboard, never under 0.5 s", () => {
    expect(signalIntervalMs(1)).toBe(500);
    expect(signalIntervalMs(2)).toBe(500);
    expect(signalIntervalMs(5)).toBe(1_000);
    expect(signalIntervalMs(29)).toBe(5_800);
    expect(signalIntervalMs(100)).toBe(20_000);
    // Pages together: aboard / interval = 5 per second once 3 or more are aboard.
    expect((100 * 1000) / signalIntervalMs(100)).toBe(5);
  });
});

const table = (o: Partial<TableView> = {}): TableView => ({
  index: 1,
  phase: "riding",
  outcome: "none",
  reason: "none",
  tell: 0,
  falseScrews: 0,
  seated: 5,
  aboard: 5,
  jumps: 0,
  places: [255, 255, 255],
  carNo: 3n,
  nextCar: 5n,
  car: key(),
  tesoroMatch: key(),
  entry: 500n,
  startedSlot: 0n,
  rideSlot: 0n,
  rideTs: T0,
  overMs: 0,
  overAt: 0,
  seats: [],
  ...o,
});

describe("finishing a ride from the Players' pages", () => {
  const mine = { carNo: 3n, table: 1 };

  it("while boarding: send the departure when it is due", () => {
    expect(nextRideStep({ mine, core: coreCar({ seated: 3 }), rollup: null, base: null, previousFrozen: false, now: T0 })).toEqual({ kind: "wait" });
    expect(nextRideStep({ mine, core: coreCar({ seated: 6, firstMinAt: T0 }), rollup: null, base: null, previousFrozen: false, now: T0 + 30 })).toEqual({ kind: "depart" });
  });

  it("after departure: start the ride when the Table is free for this car", () => {
    const core = coreCar({ stage: "departed", seated: 5, pages: 1 });
    expect(nextRideStep({ mine, core, rollup: table({ phase: "idle", carNo: 1n, nextCar: 3n }), base: null, previousFrozen: false, now: T0 }).kind).toBe("start-ride");
    // The previous car on this Table is over but core has not frozen it: finalize it first.
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over", carNo: 1n, nextCar: 3n }), base: null, previousFrozen: false, now: T0 })).toEqual({ kind: "finalize-previous", carNo: 1n });
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over", carNo: 1n, nextCar: 3n }), base: null, previousFrozen: true, now: T0 }).kind).toBe("start-ride");
    // The previous car still rides: wait.
    expect(nextRideStep({ mine, core, rollup: table({ phase: "riding", carNo: 1n, nextCar: 3n }), base: null, previousFrozen: false, now: T0 }).kind).toBe("wait");
  });

  it("during the ride: signal; once over and committed to base: finalize", () => {
    const core = coreCar({ stage: "departed", seated: 5, pages: 1 });
    expect(nextRideStep({ mine, core, rollup: table({ phase: "drawing" }), base: null, previousFrozen: false, now: T0 }).kind).toBe("signal");
    expect(nextRideStep({ mine, core, rollup: table({ phase: "riding" }), base: null, previousFrozen: false, now: T0 }).kind).toBe("signal");
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over" }), base: table({ phase: "riding" }), previousFrozen: false, now: T0 }).kind).toBe("commit");
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over" }), base: table({ phase: "over" }), previousFrozen: false, now: T0 }).kind).toBe("finalize");
  });

  it("after the result: the chunks, then the closes, then nothing", () => {
    expect(nextRideStep({ mine, core: coreCar({ stage: "settling" }), rollup: null, base: null, previousFrozen: false, now: T0 }).kind).toBe("settle");
    expect(nextRideStep({ mine, core: coreCar({ stage: "refunding" }), rollup: null, base: null, previousFrozen: false, now: T0 }).kind).toBe("settle");
    expect(nextRideStep({ mine, core: coreCar({ stage: "paid" }), rollup: null, base: null, previousFrozen: false, now: T0 }).kind).toBe("close");
    expect(nextRideStep({ mine, core: null, rollup: null, base: null, previousFrozen: false, now: T0 }).kind).toBe("done");
  });

  it("the Players the result pays send the finish; a Player aboard at Impact only watches", () => {
    const me = key();
    const placed = table({ phase: "over", outcome: "placed", places: [2, 255, 255], seats: [0, 1, 2].map((i) => ({ tableSeat: i, seat: i, order: i === 2 ? 1 : 0, jumpMs: 0, refund: 0n, account: i === 2 ? me : key() })) });
    expect(mayFinish(placed, me)).toBe(true);
    const lost = table({ phase: "over", outcome: "placed", places: [2, 255, 255], seats: [0, 1, 2].map((i) => ({ tableSeat: i, seat: i, order: 0, jumpMs: 0, refund: 0n, account: i === 0 ? me : key() })) });
    expect(mayFinish(lost, me)).toBe(false);
    const refunded = table({ phase: "over", outcome: "refund", seats: [{ tableSeat: 0, seat: 0, order: 0, jumpMs: 0, refund: 0n, account: me }] });
    expect(mayFinish(refunded, me)).toBe(true);
    const early = table({ phase: "over", outcome: "placed", seats: [{ tableSeat: 0, seat: 0, order: 1, jumpMs: 25_000, refund: 350n, account: me }] });
    expect(mayFinish(early, me)).toBe(true);
  });
});
