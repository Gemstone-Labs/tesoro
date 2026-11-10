import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import type { RideSeatView, TableView } from "./chain";
import { planPayout } from "./payout";
import { DELAYED_AFTER_SECS, railcarView } from "./view";

const key = () => Keypair.generate().publicKey;
const [ana, ben, cy, dee, eve] = [key(), key(), key(), key(), key()];
const players = [ana, ben, cy, dee, eve];
const T0 = 1_762_300_000;
const FEES = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };

const coreCar = (o: Partial<CarView> = {}): CarView =>
  ({ address: key(), payer: key(), opener: ana, n: 0n, game: key(), settleAuthority: key(), studioOwner: null, entry: 500n, openedAt: T0, deadlineAbs: T0 + 7 * 86_400, minSince: 0, firstMinAt: 0, departedAt: 0, platformBps: 200, studioBps: 300, listed: true, minSeats: 5, maxSeats: 100, seated: 5, pages: 1, stage: "boarding", refundAfter: 0, run: {} as CarView["run"], ...o }) as CarView;
const seat = (i: number): SeatView => ({ index: i, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: players[i], funder: players[i], pot: key(), signer: players[i] });
const seats = players.map((_, i) => seat(i));

const rideSeat = (i: number, order: number, jumpMs: number, refund = 0n): RideSeatView => ({ tableSeat: i, seat: i, order, jumpMs, refund, account: players[i], signer: PublicKey.default, brakeMs: null });
const table = (o: Partial<TableView> = {}): TableView => ({
  index: 0,
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
  rideTs: T0 + 40,
  overMs: 0,
  overAt: 0,
  dirty: false,
  commitAt: 0,
  brakesBound: 5,
  revealed: false,
  revealDraw: new Uint8Array(32),
  seats: players.map((_, i) => rideSeat(i, 0, 0)),
  ...o,
});

describe("the payout a result gives (core's plan_payout)", () => {
  it("the worked example: fees 129 on the Pot after Ana's refund, 521 split 313 / 130 / 78", () => {
    const p = planPayout({ entry: 500n, seated: 5, shares: [6000, 2500, 1500], refunded: 350n, ...FEES });
    expect(p.fees).toEqual([44n, 64n, 21n]);
    expect(p.won).toEqual([313n, 130n, 78n]);
  });

  it("without the early Jump: 2,350 after fees, winners 1,011 / 712 / 627", () => {
    const p = planPayout({ entry: 500n, seated: 5, shares: [6000, 2500, 1500], refunded: 0n, ...FEES });
    expect(p.won.map((w) => w + 500n)).toEqual([1011n, 712n, 627n]);
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
    expect(v.stake).toBe(2_500n);
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

  it("riding: the clock since the ride started, Tells, who is still aboard, and what I got back after my Jump", () => {
    const t = table({ tell: 1, aboard: 4, jumps: 1, seats: players.map((_, i) => (i === 0 ? rideSeat(0, 1, 25_000) : rideSeat(i, 0, 0))) });
    const v = railcarView({ me: ana.toBase58(), core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 40) * 1000 + 72_000 });
    expect(v.phase).toBe("ride");
    if (v.phase !== "ride") return;
    expect(v.clockMs).toBe(72_000);
    expect(v.tell).toBe(1);
    expect(v.aboard.map((r) => r.account)).toEqual([ben, cy, dee, eve].map((k) => k.toBase58()));
    expect(v.me).toEqual({ aboard: false, jumpMs: 25_000, back: 350n });
    // The stake is every entry in the car; it never shows a live refund percentage.
    expect(v.stake).toBe(2_500n);
  });

  it("after a Jump the screen shows at least what comes back, counting my own Brake only", () => {
    // Ana Braked at 15 s and Jumped at 21 s: 18.5 s of track, 80% (real time alone would say 70%)
    const t = table({ seats: players.map((_, i) => (i === 0 ? rideSeat(0, 1, 21_000) : rideSeat(i, 0, 0))), aboard: 4, jumps: 1 });
    const at = { core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 40) * 1000 + 30_000 };
    expect(railcarView({ ...at, me: ana.toBase58(), myBrakeMs: 15_000 })).toMatchObject({ me: { back: 400n } });
    expect(railcarView({ ...at, me: ana.toBase58() })).toMatchObject({ me: { back: 350n } });
    // a Brake pressed after the Jump never counts
    expect(railcarView({ ...at, me: ana.toBase58(), myBrakeMs: 22_000 })).toMatchObject({ me: { back: 350n } });
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
      overMs: 104_000,
      seats: [rideSeat(0, 1, 25_000, 350n), rideSeat(1, 3, 96_000), rideSeat(2, 2, 95_000), rideSeat(3, 4, 98_000), rideSeat(4, 0, 0)],
    });
    const v = railcarView({ me: dee.toBase58(), core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 200) * 1000 });
    expect(v.phase).toBe("result");
    if (v.phase !== "result") return;
    expect(v.rows.map((r) => [r.account, r.kind, r.gets])).toEqual([
      [dee.toBase58(), "place", 813n],
      [ben.toBase58(), "place", 630n],
      [cy.toBase58(), "place", 578n],
      [ana.toBase58(), "early", 350n],
      [eve.toBase58(), "aboard", 0n],
    ]);
    expect(v.fees).toBe(129n);
    expect(v.wallMs).toBe(104_000);
    expect(v.pot).toBe(2_500n);
    expect(v.mine).toMatchObject({ headline: "Last off", gets: 813n, won: 313n });
    expect(v.jumps.map((j) => j.ms)).toEqual([25_000, 95_000, 96_000, 98_000]);
  });

  it("nobody jumped: every entry back, no fees", () => {
    const t = table({ phase: "over", outcome: "refund", reason: "nobody-jumped", overMs: 31_000 });
    const v = railcarView({ me: eve.toBase58(), core: coreCar({ stage: "departed" }), seats, table: t, fees: FEES, nowMs: (T0 + 200) * 1000 });
    expect(v.phase === "result" && v.rows.every((r) => r.gets === 500n)).toBe(true);
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
    overMs: 104_000,
    seats: [rideSeat(0, 1, 25_000, 350n), rideSeat(1, 3, 96_000), rideSeat(2, 2, 95_000), rideSeat(3, 4, 98_000), rideSeat(4, 0, 0)],
  });
  const result = (me: number, s: SeatView[], o: Partial<Parameters<typeof railcarView>[0]> = {}) => {
    const v = railcarView({ me: players[me].toBase58(), core: coreCar({ stage: "departed" }), seats: s, table: worked, fees: FEES, nowMs: (T0 + 200) * 1000, ...o });
    if (v.phase !== "result") throw new Error("expected the result");
    return v;
  };

  it("Ben second-last off, backed by Bob at 40%: 630 back, Bob 578, Ben 52; Ben's own result says 52 and Bob's 578", () => {
    const v = result(1, backedSeats(1));
    expect(v.rows.find((r) => r.account === ben.toBase58())).toMatchObject({ gets: 630n, backing: { backer: bob.toBase58(), shareBps: 4_000, backerGets: 578n, playerGets: 52n } });
    expect(v.mine).toEqual({ headline: "Second-last off", gets: 52n, won: 52n, backer: { account: bob.toBase58(), gets: 578n } });
    // Nobody else's row is touched.
    expect(v.rows.filter((r) => r.backing)).toHaveLength(1);
  });

  it("an early Jump under a Backing: Ana's 350 refund goes to Bob, Ana gets 0", () => {
    const v = result(0, backedSeats(0));
    expect(v.rows.find((r) => r.account === ana.toBase58())?.backing).toMatchObject({ backerGets: 350n, playerGets: 0n });
    expect(v.mine).toMatchObject({ headline: "Jumped early", gets: 0n, won: 0n, backer: { gets: 350n } });
  });

  it("aboard at Impact under a Backing: Bob loses the 500, Eve owes nothing", () => {
    const v = result(4, backedSeats(4));
    expect(v.mine).toMatchObject({ headline: "Aboard at Impact", gets: 0n, backer: { gets: 0n } });
  });

  it("nobody jumped under a Backing: the full entry goes back to the Backer", () => {
    const refund = table({ phase: "over", outcome: "refund", reason: "nobody-jumped", overMs: 31_000 });
    const v = railcarView({ me: eve.toBase58(), core: coreCar({ stage: "departed" }), seats: backedSeats(4), table: refund, fees: FEES, nowMs: (T0 + 200) * 1000 });
    expect(v.phase === "result" && v.mine).toMatchObject({ gets: 0n, backer: { account: bob.toBase58(), gets: 500n } });
  });

  it("once core froze the run its places name the funder, after the seat itself closed", () => {
    const run = { nPlaces: 3, fees: [44n, 64n, 21n], places: [dee, ben, cy].map((p, k) => ({ seat: [3, 1, 2][k], shareBps: [6000, 2500, 1500][k], playerShareBps: p === ben ? 4_000 : 0, won: [313n, 130n, 78n][k], player: p, funder: p === ben ? bob : p })) } as unknown as CarView["run"];
    const closed = seats.map((s) => (s.index === 1 ? { ...s, seated: false } : s));
    const v = result(1, closed, { core: coreCar({ stage: "paid", run }) });
    expect(v.mine).toMatchObject({ gets: 52n, backer: { gets: 578n } });
  });

  it("an early jumper's seat closed before the page read again: the page's own Backing still splits it", () => {
    const closed = seats.map((s) => (s.index === 0 ? { ...s, seated: false } : s));
    const v = result(0, closed, { myBacking: { backer: bob.toBase58(), shareBps: 4_000 } });
    expect(v.mine).toMatchObject({ gets: 0n, backer: { account: bob.toBase58(), gets: 350n } });
  });
});

describe("a Backed Player before the result: where the Backer's Gemas go", () => {
  const bob = key();
  const backed = seats.map((s) => (s.index === 1 ? { ...s, funder: bob, shareBps: 4_000 } : s));

  it("boarding: Ben's seat names Bob, so a step-off says Bob's 500 go back to Bob", () => {
    const v = railcarView({ me: ben.toBase58(), core: coreCar({ seated: 5 }), seats: backed, table: null, fees: FEES, nowMs: T0 * 1000 });
    expect(v.phase === "boarding" && v.myBacker).toBe(bob.toBase58());
    const own = railcarView({ me: ana.toBase58(), core: coreCar({ seated: 5 }), seats: backed, table: null, fees: FEES, nowMs: T0 * 1000 });
    expect(own.phase === "boarding" && own.myBacker).toBeNull();
  });

  it("riding: after Ben's early Jump the refund is Bob's", () => {
    const t = table({ aboard: 4, jumps: 1, seats: players.map((_, i) => (i === 1 ? rideSeat(1, 1, 25_000) : rideSeat(i, 0, 0))) });
    const v = railcarView({ me: ben.toBase58(), core: coreCar({ stage: "departed" }), seats: backed, table: t, fees: FEES, nowMs: (T0 + 70) * 1000 });
    expect(v.phase === "ride" && v.me).toEqual({ aboard: false, jumpMs: 25_000, back: 350n, backer: bob.toBase58() });
  });
});
