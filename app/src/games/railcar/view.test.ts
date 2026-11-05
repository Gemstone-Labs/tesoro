import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import type { RideSeatView, TableView } from "./chain";
import { planPayout, railcarView } from "./view";

const key = () => Keypair.generate().publicKey;
const [ana, ben, cy, dee, eve] = [key(), key(), key(), key(), key()];
const players = [ana, ben, cy, dee, eve];
const T0 = 1_762_300_000;
const FEES = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };

const coreCar = (o: Partial<CarView> = {}): CarView =>
  ({ address: key(), payer: key(), opener: ana, n: 0n, game: key(), settleAuthority: key(), studioOwner: null, entry: 500n, openedAt: T0, deadlineAbs: T0 + 7 * 86_400, minSince: 0, firstMinAt: 0, departedAt: 0, platformBps: 200, studioBps: 300, listed: true, minSeats: 5, maxSeats: 100, seated: 5, pages: 1, stage: "boarding", refundAfter: 0, run: {} as CarView["run"], ...o }) as CarView;
const seat = (i: number): SeatView => ({ index: i, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: players[i], funder: players[i], pot: key(), signer: null });
const seats = players.map((_, i) => seat(i));

const rideSeat = (i: number, order: number, jumpMs: number, refund = 0n): RideSeatView => ({ tableSeat: i, seat: i, order, jumpMs, refund, account: players[i] });
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
