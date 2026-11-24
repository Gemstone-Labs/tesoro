import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import type { RideSeatView, TableView } from "./chain";
import { NO_TELLS } from "./tell-state";
import { planPayout } from "./payout";
import { DELAYED_AFTER_SECS, NO_CAR, railcarView } from "./view";

const key = () => Keypair.generate().publicKey;
const [ana, ben, cy, dee, eve] = [key(), key(), key(), key(), key()];
const players = [ana, ben, cy, dee, eve];
const T0 = 1_762_300_000;
const FEES = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };

const coreCar = (o: Partial<CarView> = {}): CarView =>
  ({ address: key(), payer: key(), opener: ana, n: 0n, game: key(), settleAuthority: key(), studioOwner: null, entry: 100n, openedAt: T0, deadlineAbs: T0 + 7 * 86_400, minSince: 0, firstMinAt: 0, departedAt: 0, platformBps: 200, studioBps: 300, listed: true, minSeats: 5, maxSeats: 100, seated: 5, pages: 1, stage: "boarding", refundAfter: 0, run: {} as CarView["run"], ...o }) as CarView;
const seat = (i: number): SeatView => ({ index: i, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: players[i], funder: players[i], pot: key(), signer: players[i] });
const seats = players.map((_, i) => seat(i));

const rideSeat = (i: number, order: number, jumpMs: number, refund = 0n): RideSeatView => ({ tableSeat: i, seat: i, order, jumpMs, refund, account: players[i], signer: PublicKey.default, brakeMs: null });
const table = (o: Partial<TableView> = {}): TableView => ({
  index: 0,
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
  rideTs: T0 + 40,
  overMs: 0,
  overAt: 0,
  dirty: false,
  commitAt: 0,
  brakesBound: 5,
  paceSlot: 0n,
  paceTs: 0,
  revealed: false,
  revealDraw: new Uint8Array(32),
  seats: players.map((_, i) => rideSeat(i, 0, 0)),
  ...o,
});

describe("the payout a result gives (core's plan_payout)", () => {
  it("the worked example: fees 30 on the Pot of 500, the 170 left split 103 / 42 / 25", () => {
    const p = planPayout({ entry: 100n, seated: 5, shares: [6000, 2500, 1500], refunded: 0n, ...FEES });
    expect(p.fees).toEqual([10n, 15n, 5n]);
    expect(p.won).toEqual([103n, 42n, 25n]);
    expect(p.won.map((w) => w + 100n)).toEqual([203n, 142n, 125n]);
  });

  it("a round 1 car with an early refund of 70 (replayed history): fees on the Pot after the refund", () => {
    const p = planPayout({ entry: 100n, seated: 5, shares: [6000, 2500, 1500], refunded: 70n, ...FEES });
    expect(p.fees).toEqual([9n, 12n, 4n]);
    expect(p.won).toEqual([64n, 26n, 15n]);
  });
});

describe("one screen from boarding to the result", () => {
  it("boarding below 5: waiting, how many are aboard, my seat", () => {
    const v = railcarView({ me: ben.toBase58(), core: coreCar({ seated: 3 }), seats: seats.slice(0, 3), table: null, fees: FEES, nowMs: (T0 + 5) * 1000 });
    expect(v.phase).toBe("boarding");
    if (v.phase !== "boarding") return;
    expect(v.seated).toBe(3);
    expect(v.leavesInSec).toBeNull();
    expect(v.mySeat).toBe(2);
    expect(v.riders.find((r) => r.me)?.account).toBe(ben.toBase58());
  });

  it("boarding from the 5th: the countdown to the fixed departure time", () => {
    const v = railcarView({ me: ana.toBase58(), core: coreCar({ seated: 5, firstMinAt: T0 + 10 }), seats, table: null, fees: FEES, nowMs: (T0 + 19) * 1000 + 400 });
    expect(v.phase === "boarding" && v.leavesInSec).toBe(21);
  });

  it("the car left: the same screen rides, the clock at 0:00 until the draw arrives", () => {
    const v = railcarView({ me: ana.toBase58(), core: coreCar({ stage: "departed" }), seats, table: null, fees: FEES, nowMs: (T0 + 41) * 1000 });
    expect(v.phase).toBe("ride");
    if (v.phase !== "ride") return;
    expect(v.clockMs).toBe(0);
    // The Prize is fixed when the car leaves: 5 entries of 100 less 6% fees; nothing is on the pile yet.
    expect([v.prize, v.pile]).toEqual([470n, 0]);
    expect(v.aboard).toHaveLength(5);
  });

  it("a car that left 2 minutes ago with no ride yet is Delayed: entries refund from the chain's refund time", () => {
    const core = coreCar({ stage: "departed", departedAt: T0, refundAfter: T0 + 86_400 });
    const at = (secs: number, t: TableView | null = null) => railcarView({ me: ana.toBase58(), core, seats, table: t, fees: FEES, nowMs: (T0 + secs) * 1000 });
    const delayed = (v: ReturnType<typeof railcarView>) => (v.phase === "ride" ? v.delayed : "not a ride");
    expect(delayed(at(DELAYED_AFTER_SECS - 1))).toBeNull();
    expect(delayed(at(DELAYED_AFTER_SECS))).toEqual({ refundAt: T0 + 86_400, refundOpen: false });
    expect(delayed(at(DELAYED_AFTER_SECS, table({ phase: "drawing", rideTs: 0 })))).toEqual({ refundAt: T0 + 86_400, refundOpen: false });
    expect(delayed(at(86_400))).toEqual({ refundAt: T0 + 86_400, refundOpen: true });
    expect(delayed(at(DELAYED_AFTER_SECS + 5, table({ rideTs: T0 + 125 })))).toBeNull();
  });

  it("a departed car without its departure time (older records) is never called Delayed", () => {
    const v = railcarView({ me: null, core: coreCar({ stage: "departed" }), seats, table: null, fees: FEES, nowMs: (T0 + 86_400) * 1000 });
    expect(v.phase === "ride" && v.delayed).toBeNull();
  });

  it("riding: the clock since the ride started, Tells, who is still aboard, and my place so far after my Jump", () => {
    const t = table({ tells: { screws: 2, panel: false, sparks: true }, aboard: 4, jumps: 1, seats: players.map((_, i) => (i === 0 ? rideSeat(0, 1, 8_000) : rideSeat(i, 0, 0))) });
    const v = railcarView({ me: ana.toBase58(), core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 40) * 1000 + 22_000 });
    expect(v.phase).toBe("ride");
    if (v.phase !== "ride") return;
    expect(v.clockMs).toBe(22_000);
    expect(v.tells).toEqual({ screws: 2, panel: false, sparks: true });
    expect(v.aboard.map((r) => r.account)).toEqual([ben, cy, dee, eve].map((k) => k.toBase58()));
    expect(v.me).toEqual({ aboard: false, jumpMs: 8_000, after: 0 });
    // Ana's 100 is on the pile; the Prize stays what it was when the car left.
    expect([v.prize, v.pile]).toEqual([470n, 1]);
  });

  it("after a Jump: how many Jumped after me so far (three or more and I am out of the paid places), never a refund", () => {
    const order = [1, 2, 3, 4, 0];
    const t = table({ seats: players.map((_, i) => rideSeat(i, order[i], order[i] ? 20_000 + order[i] * 1_000 : 0)), aboard: 1, jumps: 4 });
    const at = { core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 40) * 1000 + 30_000 };
    const me = (k: PublicKey, myBrakeMs?: number) => {
      const v = railcarView({ ...at, me: k.toBase58(), myBrakeMs });
      return v.phase === "ride" ? v.me : null;
    };
    expect(me(ana, 15_000)).toEqual({ aboard: false, jumpMs: 21_000, after: 3 });
    expect(me(ben)).toEqual({ aboard: false, jumpMs: 22_000, after: 2 });
    expect(me(dee)).toEqual({ aboard: false, jumpMs: 24_000, after: 0 });
    expect(me(eve)).toEqual({ aboard: true });
    const v = railcarView({ ...at, me: eve.toBase58() });
    expect(v.phase === "ride" && [v.prize, v.pile]).toEqual([470n, 4]);
  });

  it("another Player's Brake changes nothing on my screen: the public Table is all it reads", () => {
    const t = table({});
    const at = { core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 40) * 1000 + 30_000 };
    const ben = railcarView({ ...at, me: players[1].toBase58() });
    // Ana's Brake lives in her Brake seat and the private Vault: Ben's page gets the same facts, so the same screen
    expect(railcarView({ ...at, me: players[1].toBase58() })).toEqual(ben);
    expect(railcarView({ ...at, me: ana.toBase58(), myBrakeMs: 29_000 })).toEqual(railcarView({ ...at, me: ana.toBase58() }));
  });

  it("the result: places last off first, the early jumper, the Player aboard at Impact, fees, the wall", () => {
    const t = table({
      phase: "over",
      outcome: "placed",
      reason: "played",
      aboard: 1,
      jumps: 4,
      places: [3, 1, 2],
      overMs: 30_000,
      seats: [rideSeat(0, 1, 8_000), rideSeat(1, 3, 28_000), rideSeat(2, 2, 27_000), rideSeat(3, 4, 29_000), rideSeat(4, 0, 0)],
    });
    const v = railcarView({ me: dee.toBase58(), core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 200) * 1000 });
    expect(v.phase).toBe("result");
    if (v.phase !== "result") return;
    expect(v.rows.map((r) => [r.account, r.kind, r.gets])).toEqual([
      [dee.toBase58(), "place", 203n],
      [ben.toBase58(), "place", 142n],
      [cy.toBase58(), "place", 125n],
      [ana.toBase58(), "early", 0n],
      [eve.toBase58(), "aboard", 0n],
    ]);
    expect(v.fees).toBe(30n);
    expect(v.wallMs).toBe(30_000);
    expect(v.pot).toBe(500n);
    expect(v.mine).toMatchObject({ headline: "Last off", gets: 203n, won: 103n });
    expect(v.jumps.map((j) => j.ms)).toEqual([8_000, 27_000, 28_000, 29_000]);
  });

  it("nobody jumped: every entry back, no fees", () => {
    const t = table({ phase: "over", outcome: "refund", reason: "nobody-jumped", overMs: 31_000 });
    const v = railcarView({ me: eve.toBase58(), core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 200) * 1000 });
    expect(v.phase === "result" && v.rows.every((r) => r.gets === 100n)).toBe(true);
    expect(v.phase === "result" && v.fees).toBe(0n);
    expect(v.phase === "result" && v.mine?.headline).toBe("Nobody jumped");
  });
});

describe("a Backed seat on the result: the Backer's entry back first, the Player's Offer share of the winnings", () => {
  const bob = key();
  /** Seat `i` funded by Bob, the Player keeping `shareBps` of the winnings. */
  const backedSeats = (i: number, shareBps = 4_000) => seats.map((s) => (s.index === i ? { ...s, funder: bob, shareBps } : s));
  const worked = table({
    phase: "over",
    outcome: "placed",
    reason: "played",
    aboard: 1,
    jumps: 4,
    places: [3, 1, 2],
    overMs: 30_000,
    seats: [rideSeat(0, 1, 8_000), rideSeat(1, 3, 28_000), rideSeat(2, 2, 27_000), rideSeat(3, 4, 29_000), rideSeat(4, 0, 0)],
  });
  const result = (me: number, s: SeatView[], o: Partial<Parameters<typeof railcarView>[0]> = {}) => {
    const v = railcarView({ me: players[me].toBase58(), core: coreCar({ stage: "departed" }), seats: s, table: worked, fees: FEES, nowMs: (T0 + 200) * 1000, ...o });
    if (v.phase !== "result") throw new Error("expected the result");
    return v;
  };

  it("Ben second-last off, backed by Bob at 40%: 142 back, Bob 126, Ben 16; Ben's own result says 16 and Bob's 126", () => {
    const v = result(1, backedSeats(1));
    expect(v.rows.find((r) => r.account === ben.toBase58())).toMatchObject({ gets: 142n, backing: { backer: bob.toBase58(), shareBps: 4_000, backerGets: 126n, playerGets: 16n } });
    expect(v.mine).toEqual({ headline: "Second-last off", gets: 16n, won: 16n, backer: { account: bob.toBase58(), gets: 126n } });
    // Nobody else's row is touched.
    expect(v.rows.filter((r) => r.backing)).toHaveLength(1);
  });

  it("an early Jump under a Backing: Bob loses the entry like at Impact, Ana gets 0", () => {
    const v = result(0, backedSeats(0));
    expect(v.rows.find((r) => r.account === ana.toBase58())?.backing).toMatchObject({ backerGets: 0n, playerGets: 0n });
    expect(v.mine).toMatchObject({ headline: "Jumped early", gets: 0n, won: 0n, backer: { gets: 0n } });
  });

  it("aboard at Impact under a Backing: Bob loses the 100, Eve owes nothing", () => {
    const v = result(4, backedSeats(4));
    expect(v.mine).toMatchObject({ headline: "Aboard at the blast", gets: 0n, backer: { gets: 0n } });
  });

  it("nobody jumped under a Backing: the full entry goes back to the Backer", () => {
    const refund = table({ phase: "over", outcome: "refund", reason: "nobody-jumped", overMs: 31_000 });
    const v = railcarView({ me: eve.toBase58(), core: coreCar({ stage: "departed" }), seats: backedSeats(4), table: refund, fees: FEES, nowMs: (T0 + 200) * 1000 });
    expect(v.phase === "result" && v.mine).toMatchObject({ gets: 0n, backer: { account: bob.toBase58(), gets: 100n } });
  });

  it("once core froze the run its places name the funder, after the seat itself closed", () => {
    const run = { nPlaces: 3, fees: [10n, 15n, 5n], places: [dee, ben, cy].map((p, k) => ({ seat: [3, 1, 2][k], shareBps: [6000, 2500, 1500][k], playerShareBps: p === ben ? 4_000 : 0, won: [103n, 42n, 25n][k], player: p, funder: p === ben ? bob : p })) } as unknown as CarView["run"];
    const closed = seats.map((s) => (s.index === 1 ? { ...s, seated: false } : s));
    const v = result(1, closed, { core: coreCar({ stage: "paid", run }) });
    expect(v.mine).toMatchObject({ gets: 16n, backer: { gets: 126n } });
  });

  it("an early jumper's seat closed before the page read again: the page's own Backing still splits it", () => {
    const closed = seats.map((s) => (s.index === 0 ? { ...s, seated: false } : s));
    const v = result(0, closed, { myBacking: { backer: bob.toBase58(), shareBps: 4_000 } });
    expect(v.mine).toMatchObject({ gets: 0n, backer: { account: bob.toBase58(), gets: 0n } });
  });
});

describe("a Backed Player before the result: where the Backer's Gemas go", () => {
  const bob = key();
  const backed = seats.map((s) => (s.index === 1 ? { ...s, funder: bob, shareBps: 4_000 } : s));

  it("boarding: Ben's seat names Bob, so a step-off says Bob's 100 go back to Bob", () => {
    const v = railcarView({ me: ben.toBase58(), core: coreCar({ seated: 5 }), seats: backed, table: null, fees: FEES, nowMs: T0 * 1000 });
    expect(v.phase === "boarding" && v.myBacker).toBe(bob.toBase58());
    const own = railcarView({ me: ana.toBase58(), core: coreCar({ seated: 5 }), seats: backed, table: null, fees: FEES, nowMs: T0 * 1000 });
    expect(own.phase === "boarding" && own.myBacker).toBeNull();
  });

  it("riding: after Ben's early Jump nothing comes back, and the seat still names Bob", () => {
    const t = table({ aboard: 4, jumps: 1, seats: players.map((_, i) => (i === 1 ? rideSeat(1, 1, 25_000) : rideSeat(i, 0, 0))) });
    const v = railcarView({ me: ben.toBase58(), core: coreCar({ stage: "departed" }), seats: backed, table: t, fees: FEES, nowMs: (T0 + 70) * 1000 });
    expect(v.phase === "ride" && v.me).toEqual({ aboard: false, jumpMs: 25_000, after: 0, backer: bob.toBase58() });
  });
});

describe("before any car is read", () => {
  it("the first rider's Board button names the round 2 entry, 100, not round 1's 500 (cross-lab S6)", () => {
    expect(NO_CAR).toMatchObject({ phase: "boarding", seated: 0, entry: 100n });
  });
});
