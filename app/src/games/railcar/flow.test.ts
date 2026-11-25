import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { CarView, SeatPageView, SeatView } from "../../lib/chain/many-seat";
import type { TableView } from "./chain";
import { NO_TELLS } from "./tell-state";
import { JUMP_NOT_STARTED, JUMP_POLL_MS, boardingSteps, departureDue, mayFinish, nextRideStep, pageIntervalMs, previousDone, queueChoice, seatToJump, sendJump, signalIntervalMs, watchedRide, withPushedTable } from "./flow";

const key = () => Keypair.generate().publicKey;
const T0 = 1_762_300_000;

const coreCar = (o: Partial<CarView> = {}): CarView =>
  ({ address: key(), payer: key(), opener: key(), n: 0n, game: key(), settleAuthority: key(), studioOwner: null, entry: 100n, openedAt: T0, deadlineAbs: T0 + 7 * 86_400, minSince: 0, firstMinAt: 0, departedAt: 0, platformBps: 200, studioBps: 300, listed: true, minSeats: 5, maxSeats: 100, seated: 0, pages: 0, stage: "boarding", refundAfter: T0 + 86_400, run: {} as CarView["run"], ...o }) as CarView;
const seat = (index: number, seated = true): SeatView => ({ index, seated, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: key(), funder: key(), pot: key(), signer: key() });
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
    expect(departureDue(coreCar({ ...five, minSince: T0 + 35 }), T0 + 40)).toBe(true);
    // Below 5 at the end time: the car waits, then leaves the moment a 5th boards.
    expect(departureDue(coreCar({ ...five, seated: 4, minSince: 0 }), T0 + 60)).toBe(false);
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

  it("a page whose Player is off shares the backup rate with every seat: 100 seated, 5 aboard is about 10 a second, not 100", () => {
    // aboard pages beat at the aboard rate: 5 aboard, one beat a second each
    expect(pageIntervalMs({ aboard: 5, seated: 100, mine: "aboard" })).toBe(1_000);
    // a Jumped Player's page beats as if every seat had a page open: 20 s
    expect(pageIntervalMs({ aboard: 5, seated: 100, mine: "off" })).toBe(20_000);
    const perSec = 5 * (1000 / pageIntervalMs({ aboard: 5, seated: 100, mine: "aboard" })) + 95 * (1000 / pageIntervalMs({ aboard: 5, seated: 100, mine: "off" }));
    expect(perSec).toBe(9.75);
    // 5 seated, 1 aboard: that page at 0.5 s (2/s) and 4 off at 1 s (4/s)
    expect(pageIntervalMs({ aboard: 1, seated: 5, mine: "aboard" })).toBe(500);
    expect(pageIntervalMs({ aboard: 1, seated: 5, mine: "off" })).toBe(1_000);
  });
});

const table = (o: Partial<TableView> = {}): TableView => ({
  index: 1,
  phase: "riding",
  outcome: "none",
  reason: "none",
  tells: NO_TELLS,
  seated: 5,
  aboard: 5,
  jumps: 0,
  places: [255, 255, 255],
  rules: 3,
  carNo: 3n,
  nextCar: 5n,
  car: key(),
  tesoroMatch: key(),
  entry: 100n,
  startedSlot: 0n,
  rideSlot: 0n,
  rideTs: T0,
  overMs: 0,
  overAt: 0,
  dirty: false,
  commitAt: 0,
  seats: [],
  brakesBound: 0,
  deadlineAbs: 0,
  paceSlot: 0n,
  paceTs: 0,
  revealed: false,
  revealDraw: new Uint8Array(32),
  ...o,
});

describe("finishing a ride from the Players' pages", () => {
  const mine = { carNo: 3n, table: 1 };

  it("while boarding: send the departure when it is due", () => {
    expect(nextRideStep({ mine, core: coreCar({ seated: 3 }), rollup: null, base: null, previousReceipt: false, now: T0 })).toEqual({ kind: "wait" });
    expect(nextRideStep({ mine, core: coreCar({ seated: 6, firstMinAt: T0 }), rollup: null, base: null, previousReceipt: false, now: T0 + 30 })).toEqual({ kind: "depart" });
  });

  it("after departure: start the ride when the Table is free for this car", () => {
    const core = coreCar({ stage: "departed", seated: 5, pages: 1 });
    expect(nextRideStep({ mine, core, rollup: table({ phase: "idle", carNo: 1n, nextCar: 3n }), base: null, previousReceipt: false, now: T0 }).kind).toBe("start-ride");
    // The previous car on this Table is over but core has not frozen it: finalize it first.
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over", carNo: 1n, nextCar: 3n }), base: null, previousReceipt: false, now: T0 })).toEqual({ kind: "finalize-previous", carNo: 1n });
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over", carNo: 1n, nextCar: 3n }), base: null, previousReceipt: true, now: T0 }).kind).toBe("start-ride");
    // The previous car still rides: wait.
    expect(nextRideStep({ mine, core, rollup: table({ phase: "riding", carNo: 1n, nextCar: 3n }), base: null, previousReceipt: false, now: T0 }).kind).toBe("wait");
  });

  it("after departure: a Table over without the previous car's receipt frees for a car that left (base time) at or after that car's core deadline", () => {
    const prevDeadline = T0 + 7 * 86_400;
    const step = (t: Partial<TableView>, departedAt: number, now = departedAt + 60) =>
      nextRideStep({
        mine,
        core: coreCar({ stage: "departed", seated: 5, pages: 1, departedAt, refundAfter: departedAt + 86_400, deadlineAbs: departedAt + 7 * 86_400 }),
        rollup: table({ phase: "over", carNo: 1n, nextCar: 3n, deadlineAbs: prevDeadline, ...t }),
        base: null,
        previousReceipt: false,
        now,
      }).kind;
    expect(step({}, prevDeadline - 1)).toBe("finalize-previous");
    expect(step({}, prevDeadline)).toBe("start-ride");
    // the clock proves nothing: a car that left before the deadline stays refused however late it is now
    expect(step({}, prevDeadline - 1, prevDeadline + 3_000)).toBe("finalize-previous");
    // a legacy Table (no deadline recorded): the car must have left two weeks less an hour after the ride's end
    const reuse = 14 * 86_400 - 3_600;
    expect(step({ deadlineAbs: 0, overAt: T0 }, T0 + reuse - 1)).toBe("finalize-previous");
    expect(step({ deadlineAbs: 0, overAt: T0 }, T0 + reuse)).toBe("start-ride");
    expect(step({ deadlineAbs: 0, overAt: 0 }, T0 + reuse)).toBe("finalize-previous");
    expect(previousDone({ phase: "over", overAt: T0, deadlineAbs: prevDeadline }, false, { departedAt: prevDeadline })).toBe(true);
    expect(previousDone({ phase: "over", overAt: T0, deadlineAbs: prevDeadline }, false, { departedAt: prevDeadline - 1 })).toBe(false);
    expect(previousDone({ phase: "over", overAt: T0, deadlineAbs: prevDeadline }, true, { departedAt: T0 })).toBe(true);
    expect(previousDone({ phase: "idle", overAt: 0, deadlineAbs: 0 }, false, { departedAt: T0 })).toBe(true);
  });

  it("after a reuse, both cars: the previous one (Departed, off its Table) and one that waited past its refund time go to core's refund", () => {
    const prev = nextRideStep({
      mine: { carNo: 1n, table: 1 },
      core: coreCar({ stage: "departed", seated: 5, pages: 1, departedAt: T0, refundAfter: T0 + 86_400 }),
      rollup: table({ phase: "riding", carNo: 3n, nextCar: 5n }),
      base: null,
      previousReceipt: false,
      now: T0 + 8 * 86_400,
    });
    expect(prev).toEqual({ kind: "refund" });
    const waited = (now: number) =>
      nextRideStep({
        mine,
        core: coreCar({ stage: "departed", seated: 5, pages: 1, departedAt: T0, refundAfter: T0 + 86_400 }),
        rollup: table({ phase: "over", carNo: 1n, nextCar: 3n, deadlineAbs: T0 - 1 }),
        base: null,
        previousReceipt: false,
        now,
      }).kind;
    expect(waited(T0 + 86_399)).toBe("start-ride");
    expect(waited(T0 + 86_400)).toBe("refund");
  });

  it("during the ride: signal; once over and committed to base: finalize", () => {
    const core = coreCar({ stage: "departed", seated: 5, pages: 1 });
    expect(nextRideStep({ mine, core, rollup: table({ phase: "drawing" }), base: null, previousReceipt: false, now: T0 }).kind).toBe("signal");
    expect(nextRideStep({ mine, core, rollup: table({ phase: "riding" }), base: null, previousReceipt: false, now: T0 }).kind).toBe("signal");
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over", overAt: T0 - 200, commitAt: T0 - 200 }), base: table({ phase: "riding" }), previousReceipt: false, now: T0 }).kind).toBe("commit");
    expect(nextRideStep({ mine, core, rollup: table({ phase: "over" }), base: table({ phase: "over" }), previousReceipt: false, now: T0 }).kind).toBe("finalize");
  });

  it("commit: sent when the result is owed, or as a repeat only after the program's wait and inside its window", () => {
    // (a car whose refund time has come goes to core's refund instead: the next test)
    const core = coreCar({ stage: "departed", seated: 5, pages: 1, refundAfter: T0 + 3 * 86_400 });
    const step = (over: Partial<TableView>, now: number) => nextRideStep({ mine, core, rollup: table({ phase: "over", overAt: T0, commitAt: T0, ...over }), base: table({ phase: "riding" }), previousReceipt: false, now }).kind;
    // the ride just ended and was committed by the rollup itself: the base copy is only late
    expect(step({}, T0 + 1)).toBe("wait");
    expect(step({}, T0 + 119)).toBe("wait");
    // the program's first repeat is due 120 s after the last commit
    expect(step({}, T0 + 120)).toBe("commit");
    // a result the Sponsor could not pay is owed at once
    expect(step({ dirty: true }, T0 + 1)).toBe("commit");
    // past the window the program refuses every repeat (core takes over), so the page stops
    expect(step({ commitAt: T0 + 86_000 }, T0 + 86_400 + 500)).toBe("wait");
    expect(step({ dirty: true }, T0 + 86_400 + 1)).toBe("commit");
  });

  it("after the result: the chunks, then the closes, then nothing", () => {
    expect(nextRideStep({ mine, core: coreCar({ stage: "settling" }), rollup: null, base: null, previousReceipt: false, now: T0 }).kind).toBe("settle");
    expect(nextRideStep({ mine, core: coreCar({ stage: "refunding" }), rollup: null, base: null, previousReceipt: false, now: T0 }).kind).toBe("settle");
    expect(nextRideStep({ mine, core: coreCar({ stage: "paid" }), rollup: null, base: null, previousReceipt: false, now: T0 }).kind).toBe("close");
    expect(nextRideStep({ mine, core: null, rollup: null, base: null, previousReceipt: false, now: T0 }).kind).toBe("done");
  });

  it("the Players the result pays send the finish; a Player aboard at Impact only watches", () => {
    const me = key();
    const placed = table({ phase: "over", outcome: "placed", places: [2, 255, 255], seats: [0, 1, 2].map((i) => ({ tableSeat: i, seat: i, order: i === 2 ? 1 : 0, jumpMs: 0, refund: 0n, account: i === 2 ? me : key(), signer: PublicKey.default, brakeMs: null })) });
    expect(mayFinish(placed, me)).toBe(true);
    const lost = table({ phase: "over", outcome: "placed", places: [2, 255, 255], seats: [0, 1, 2].map((i) => ({ tableSeat: i, seat: i, order: 0, jumpMs: 0, refund: 0n, account: i === 0 ? me : key(), signer: PublicKey.default, brakeMs: null })) });
    expect(mayFinish(lost, me)).toBe(false);
    const refunded = table({ phase: "over", outcome: "refund", seats: [{ tableSeat: 0, seat: 0, order: 0, jumpMs: 0, refund: 0n, account: me, signer: PublicKey.default, brakeMs: null }] });
    expect(mayFinish(refunded, me)).toBe(true);
    const early = table({ phase: "over", outcome: "placed", seats: [{ tableSeat: 0, seat: 0, order: 1, jumpMs: 25_000, refund: 350n, account: me, signer: PublicKey.default, brakeMs: null }] });
    expect(mayFinish(early, me)).toBe(true);
  });
});

describe("what a Spectator watches", () => {
  const t = (index: number, carNo: bigint, phase: TableView["phase"], overAt = 0) => ({ index, carNo, phase, overAt }) as TableView;

  it("the live ride: the newest car riding (or waiting for its draw)", () => {
    expect(watchedRide([t(0, 4n, "riding"), t(1, 5n, "drawing")], T0)?.carNo).toBe(5n);
    expect(watchedRide([t(0, 6n, "riding"), t(1, 5n, "over", T0 - 5)], T0)?.carNo).toBe(6n);
  });

  it("a ride that just ended, for its Result, until a minute after the wall", () => {
    expect(watchedRide([t(0, 6n, "over", T0 - 59), t(1, 5n, "over", T0 - 200)], T0)?.carNo).toBe(6n);
    expect(watchedRide([t(0, 6n, "over", T0 - 61)], T0)).toBeNull();
  });

  it("nothing riding: none (the page shows the boarding car)", () => {
    expect(watchedRide([t(0, 0n, "idle"), t(1, 0n, "idle")], T0)).toBeNull();
    expect(watchedRide([], T0)).toBeNull();
  });
});

describe("the seat a Jump names (ticket 40)", () => {
  const qsA = key();
  const phone = key();
  const rideSeat = (tableSeat: number, account: PublicKey) => ({ tableSeat, seat: tableSeat, order: 0, jumpMs: 0, refund: 0n, account, signer: key(), brakeMs: null });
  // Car 18 on staging: Table 0 still held car 16 (qsA in seat 0) when the car left; car 18 put the phone in seat 0, qsA in 1.
  const car16 = table({ index: 0, carNo: 16n, phase: "over", outcome: "placed", seats: [rideSeat(0, qsA)] });
  const car18 = (phase: TableView["phase"]) => table({ index: 0, carNo: 18n, phase, seats: [rideSeat(0, phone), rideSeat(1, qsA)] });
  const jumpOn = (first: TableView | null, later: (TableView | null)[], waitMs = 10_000) => {
    let clock = 0;
    const reads = [...later];
    const f = { reads: 0 };
    const seat = seatToJump({
      carNo: 18n,
      me: qsA,
      table: first,
      reread: async () => {
        f.reads++;
        return reads.length > 1 ? reads.shift()! : reads[0];
      },
      waitMs,
      pollMs: 800,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    return { seat, f };
  };

  it("a Table still holding the previous car names no seat: the Jump waits for this car's ride and names qsA's seat in it", async () => {
    const { seat, f } = jumpOn(car16, [car16, car18("drawing"), car18("riding")]);
    expect(await seat).toBe(1);
    expect(f.reads).toBe(3);
  });

  it("a Table riding this car names the seat at once", async () => {
    const { seat, f } = jumpOn(car18("riding"), []);
    expect(await seat).toBe(1);
    expect(f.reads).toBe(0);
  });

  it("a ride that never starts on the Table: the Jump stops after the wait and says so", async () => {
    await expect(jumpOn(car16, [car16]).seat).rejects.toThrow(JUMP_NOT_STARTED);
    await expect(jumpOn(null, [null]).seat).rejects.toThrow(JUMP_NOT_STARTED);
  });

  it("this car's ride already over: nothing to send", async () => {
    const { seat, f } = jumpOn(car18("over"), []);
    expect(await seat).toBeNull();
    expect(f.reads).toBe(0);
  });
});

describe("a Jump goes out without waiting on page work (ticket 41)", () => {
  const qsB = key();
  const rideSeat = (tableSeat: number, account: PublicKey) => ({ tableSeat, seat: tableSeat, order: 0, jumpMs: 0, refund: 0n, account, signer: key(), brakeMs: null });
  const car19 = (phase: TableView["phase"]) => table({ index: 1, carNo: 19n, phase, seats: [rideSeat(0, key()), rideSeat(1, qsB)] });
  const car17 = table({ index: 1, carNo: 17n, phase: "over", seats: [rideSeat(0, qsB)] });

  /** A page as the Jump sees it, on a clock the test moves: what it holds, and a log of every request with its time. */
  const page = (o: { held: (ms: number) => TableView | null; readTable?: (ms: number) => TableView | null; tickerHash?: string | null; rttMs?: number }) => {
    let clock = 0;
    const rtt = o.rttMs ?? 340;
    const log: string[] = [];
    const done = sendJump({
      carNo: 19n,
      me: qsB,
      held: () => o.held(clock),
      read: async () => {
        log.push(`read@${clock}`);
        clock += rtt;
        return (o.readTable ?? o.held)(clock);
      },
      heldHash: () => o.tickerHash ?? null,
      fetchHash: async () => {
        log.push(`hash@${clock}`);
        return "fetched";
      },
      send: async (seat, hash) => {
        log.push(`send@${clock} seat ${seat} ${hash}`);
        return "sig";
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    return { done, log };
  };

  it("car 19's qsB: riding and the ride ticker holds a recent hash, so the Jump is the first request, at the tap", async () => {
    const { done, log } = page({ held: () => car19("riding"), tickerHash: "ticker" });
    expect(await done).toBe("sig");
    expect(log).toEqual(["send@0 seat 1 ticker"]);
  });

  it("no hash held yet: the one hash request goes out at the tap, and no Table read", async () => {
    const { done, log } = page({ held: () => car19("riding") });
    await done;
    expect(log).toEqual(["hash@0", "send@0 seat 1 fetched"]);
  });

  it("car 19's qsA, tapped 1.05 s before the ride: the Jump goes out within one poll of the pushed Table riding, with no rollup read and the hash fetched during the wait", async () => {
    const pushed = (ms: number) => (ms < 1_050 ? car17 : ms < 1_400 ? car19("drawing") : car19("riding"));
    const { done, log } = page({ held: pushed });
    await done;
    expect(log[0]).toBe("hash@0");
    expect(log.filter((l) => l.startsWith("read"))).toEqual([]);
    const at = Number(log[1].match(/^send@(\d+)/)![1]);
    expect(at).toBeGreaterThanOrEqual(1_400);
    expect(at).toBeLessThanOrEqual(1_400 + JUMP_POLL_MS);
  });

  it("the page holds no fresh Table (a silent websocket): it reads the rollup Table itself and sends as that read answers riding", async () => {
    const { done, log } = page({ held: () => null, readTable: () => car19("riding"), tickerHash: "ticker" });
    await done;
    expect(log).toEqual(["read@0", "send@340 seat 1 ticker"]);
  });

  it("this car's ride is over: nothing goes out", async () => {
    const { done, log } = page({ held: () => car19("over"), tickerHash: "ticker" });
    expect(await done).toBeNull();
    expect(log).toEqual([]);
  });
});

describe("a Table the websocket pushes shows at once (ticket 41)", () => {
  const car = { carNo: 19n, table: 1, match: key() };
  const snap = { car, rollup: table({ index: 1, carNo: 19n, tells: NO_TELLS }), base: null };
  const glow = table({ index: 1, carNo: 19n, tells: { screws: 1, panel: false, sparks: false } });

  it("the car shown, on its Table: the snapshot takes the pushed Table (car 19's Glow), and keeps the rest", () => {
    const next = withPushedTable(snap, 1, glow);
    expect(next?.rollup?.tells.screws).toBe(1);
    expect(next?.car).toBe(car);
  });

  it("a push for another Table, or the Table still holding another car, changes nothing", () => {
    expect(withPushedTable(snap, 0, glow)).toBeNull();
    expect(withPushedTable(snap, 1, table({ index: 1, carNo: 17n, phase: "over" }))).toBeNull();
    expect(withPushedTable(null, 1, glow)).toBeNull();
    expect(withPushedTable({ car: null, rollup: null }, 1, glow)).toBeNull();
  });
});
