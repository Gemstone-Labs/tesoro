/**
 * Railcar screen states built through the real screen model (`railcarView`) from chain-shaped records: the spec's
 * worked example (Ana, Ben, Cy, Dee, Eve) and larger cars. Used by Storybook and the screen tests; no network.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import type { StoredRide } from "../../lib/chain/ride-record";
import type { RideSeatView, TableView } from "./chain";
import { refund, ride } from "./engine";
import { railcarView, type FeeRates, type RailcarView } from "./view";

export const FIXTURE_FEES: FeeRates = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };
const T0 = 1_762_300_000;

/** A fixed key per name, so a story shows the same avatar every time. */
const keyOf = (i: number) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? i + 1 : 7))).publicKey;
export const PLAYERS: PublicKey[] = Array.from({ length: 100 }, (_, i) => keyOf(i));
/** The worked example: Ana, Ben, Cy, Dee, Eve. */
export const [ANA, BEN, CY, DEE, EVE] = PLAYERS;
/** A Backer (not in the car): Bob. */
export const BOB = keyOf(800);

/** A seat funded by a Backer: core seat `seat`, the Player keeping `shareBps` of the winnings. */
export interface FixtureBacking {
  seat: number;
  backer: PublicKey;
  shareBps: number;
}

const coreCar = (o: Partial<CarView>): CarView =>
  ({ address: keyOf(500), payer: ANA, opener: ANA, n: 0n, game: keyOf(501), settleAuthority: keyOf(502), studioOwner: null, entry: 500n, openedAt: T0, deadlineAbs: T0 + 7 * 86_400, minSince: 0, firstMinAt: 0, departedAt: 0, platformBps: 200, studioBps: 300, listed: true, minSeats: 5, maxSeats: 100, seated: 0, pages: 0, stage: "boarding", refundAfter: 0, run: { nPlaces: 0 } as CarView["run"], ...o }) as CarView;

const seats = (n: number, backed?: FixtureBacking): SeatView[] =>
  PLAYERS.slice(0, n).map((p, i) => ({ index: i, seated: true, shareBps: i === backed?.seat ? backed.shareBps : 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: p, funder: i === backed?.seat ? backed.backer : p, pot: keyOf(600 + i), signer: null }));

const rideSeat = (i: number, order = 0, jumpMs = 0, refund = 0n): RideSeatView => ({ tableSeat: i, seat: i, order, jumpMs, refund, account: PLAYERS[i], signer: PublicKey.default });

const table = (n: number, o: Partial<TableView>): TableView => ({
  index: 0,
  phase: "riding",
  outcome: "none",
  reason: "none",
  tell: 0,
  falseScrews: 0,
  seated: n,
  aboard: n,
  jumps: 0,
  places: [255, 255, 255],
  carNo: 3n,
  nextCar: 5n,
  car: keyOf(700),
  tesoroMatch: keyOf(500),
  entry: 500n,
  startedSlot: 0n,
  rideSlot: 0n,
  rideTs: T0 + 60,
  overMs: 0,
  overAt: 0,
  dirty: false,
  commitAt: 0,
  seats: Array.from({ length: n }, (_, i) => rideSeat(i)),
  ...o,
});

const view = (me: PublicKey | null, core: CarView, n: number, t: TableView | null, nowSec: number, backed?: FixtureBacking): RailcarView =>
  railcarView({ me: me?.toBase58() ?? null, core, seats: seats(n, backed), table: t, fees: FIXTURE_FEES, nowMs: nowSec * 1000 });

/** Boarding below 5: no countdown yet. `me` boarded as the 3rd. */
export const boardingWaiting = (me: PublicKey | null = CY) => view(me, coreCar({ seated: 3, pages: 1 }), 3, null, T0 + 20);
/** Boarding with 37 aboard, 21 s to go; the Player in seat 14. */
export const boardingCountdown = (me: PublicKey | null = PLAYERS[13], backed?: FixtureBacking) => view(me, coreCar({ seated: 37, pages: 4, firstMinAt: T0 + 30 }), 37, null, T0 + 39, backed);
/** The car that is boarding, seen by a Player who has not boarded. */
export const boardingNotAboard = () => boardingCountdown(null);

/** Riding with 29 aboard of 40, 1:12 on the clock, screws heard; the Player (seat 1) still aboard. */
export function riding(me: PublicKey | null = PLAYERS[0], o: { jumpedMe?: boolean; backed?: FixtureBacking } = {}): RailcarView {
  const n = 40;
  const out = new Set([3, 5, 8, 11, 14, 17, 20, 23, 26, 30, 33]);
  if (o.jumpedMe) out.add(0);
  const seatsT = Array.from({ length: n }, (_, i) => (out.has(i) ? rideSeat(i, [...out].indexOf(i) + 1, i === 0 ? 25_000 : 20_000 + i * 1_000) : rideSeat(i)));
  return view(me, coreCar({ stage: "departed", seated: n, pages: 4 }), n, table(n, { tell: 1, aboard: n - out.size, jumps: out.size, seats: seatsT }), T0 + 60 + 72, o.backed);
}

/** The car just left: the ride clock waits for the draw (0:00), the car already rolls. */
export const rideStarting = (me: PublicKey | null = PLAYERS[0]) => view(me, coreCar({ stage: "departed", seated: 37, pages: 4 }), 37, null, T0 + 61);

/** The worked example after Impact, as `me` sees it (Dee last off by default). */
export function workedResult(me: PublicKey | null = DEE, backed?: FixtureBacking): RailcarView {
  const t = table(5, {
    phase: "over",
    outcome: "placed",
    reason: "played",
    aboard: 1,
    jumps: 4,
    places: [3, 1, 2],
    overMs: 104_000,
    seats: [rideSeat(0, 1, 25_000, 350n), rideSeat(1, 3, 96_000), rideSeat(2, 2, 95_000), rideSeat(3, 4, 98_000), rideSeat(4)],
  });
  return view(me, coreCar({ stage: "departed", seated: 5, pages: 1 }), 5, t, T0 + 200, backed);
}

/** Nobody jumped: every entry back, no fees. */
export const nobodyJumped = (me: PublicKey | null = EVE) => view(me, coreCar({ stage: "departed", seated: 5, pages: 1 }), 5, table(5, { phase: "over", outcome: "refund", reason: "nobody-jumped", overMs: 31_000 }), T0 + 200);

/** A live run for the in-place story: boarding counts down, the car leaves, Players Jump, the wall. `t` = seconds since open. */
export function liveAt(t: number, me: PublicKey = PLAYERS[0]): RailcarView {
  const n = 24;
  const boarded = Math.min(n, 2 + Math.floor(t * 1.5));
  const fifth = 2;
  const leaves = fifth + 30;
  if (t < leaves) return view(me, coreCar({ seated: boarded, pages: 3, firstMinAt: boarded >= 5 ? T0 + fifth : 0 }), boarded, null, T0 + t);
  const rideT = t - leaves - 1;
  if (rideT < 0) return view(me, coreCar({ stage: "departed", seated: n, pages: 3 }), n, null, T0 + t);
  const wall = 40;
  const jumpAt = (i: number) => (i === 0 ? 33 : 4 + ((i * 37) % 36));
  const over = rideT >= wall;
  const ms = Math.min(rideT, wall) * 1000;
  const seatsT = Array.from({ length: n }, (_, i) => rideSeat(i));
  const order = Array.from({ length: n }, (_, i) => i)
    .filter((i) => jumpAt(i) * 1000 <= ms && i % 4 !== 1)
    .sort((a, b) => jumpAt(a) - jumpAt(b));
  order.forEach((i, k) => (seatsT[i] = rideSeat(i, k + 1, jumpAt(i) * 1000, 0n)));
  const tell = rideT >= 37 ? 3 : rideT >= 30 ? 2 : rideT >= 15 ? 1 : 0;
  const placed = order.slice(-3).reverse();
  if (over) {
    for (const i of order.slice(0, -3)) seatsT[i] = { ...seatsT[i], refund: refund(500n, jumpAt(i) * 1000) };
  }
  const t2 = table(n, over ? { phase: "over", outcome: "placed", reason: "played", places: [...placed, 255, 255, 255].slice(0, 3), overMs: wall * 1000, aboard: n - order.length, jumps: order.length, seats: seatsT, tell: 3 } : { tell, aboard: n - order.length, jumps: order.length, seats: seatsT, rideTs: T0 + leaves + 1 });
  return view(me, coreCar({ stage: "departed", seated: n, pages: 3 }), n, t2, T0 + t);
}

/** A draw whose crash point is exactly `crashMs` (the Rust ride tests' search: words 1-3 fixed, word 0 searched). */
export function drawWithCrash(crashMs: number): Uint8Array {
  const withWord = (w0: bigint) => {
    const d = new Uint8Array(32).fill(0x5a);
    for (let i = 0; i < 8; i++) d[i] = Number((w0 >> BigInt(8 * i)) & 0xffn);
    return d;
  };
  const crash = (w0: bigint) => ride(withWord(w0)).crashMs;
  let [lo, hi] = [0n, (1n << 64n) - 1n];
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (crash(mid) > crashMs) lo = mid + 1n;
    else hi = mid;
  }
  if (crash(lo) !== crashMs) throw new Error(`no draw gives ${crashMs} ms`);
  return withWord(lo);
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The worked example as the Match history keeps it (`/api/match/<id>`): the wall at 1:44 of track, Ana off at 0:25 (350),
 * Cy, Ben, Dee off at 1:35-1:39, Eve aboard; fees 129. `brake`: Dee also Braked at 1:30, so the wall came 2.5 s later on
 * the clock. `tamper`: the record says Ana got 400 back, which the replay does not give.
 */
export function storedWorkedRide(o: { brake?: boolean; tamper?: boolean } = {}): { id: string; game: "railcar"; entry: number; status: "settled"; openedAt: number; settledAt: number; ride: StoredRide } {
  const who = [ANA, BEN, CY, DEE, EVE].map((k) => k.toBase58());
  const seat = (i: number, order = 0, jumpMs = 0, back = 0) => ({ seat: i, player: who[i], funder: who[i], shareBps: 0, order, jumpMs, refund: back });
  return {
    id: `${who[0]}-7`,
    game: "railcar",
    entry: 500,
    status: "settled",
    openedAt: (T0 + 60) * 1000,
    settledAt: (T0 + 200) * 1000,
    ride: {
      carNo: "7",
      outcome: "placed",
      reason: "played",
      draw: hexOf(drawWithCrash(104_000)),
      brakes: o.brake ? [{ seat: 3, ms: 90_000 }] : [],
      seats: [seat(0, 1, 25_000, o.tamper ? 400 : 350), seat(1, 3, 97_000), seat(2, 2, 95_000), seat(3, 4, 99_000), seat(4)],
      places: [
        { place: 1, seat: 3, player: who[3], funder: who[3], shareBps: 0, won: 313 },
        { place: 2, seat: 1, player: who[1], funder: who[1], shareBps: 0, won: 130 },
        { place: 3, seat: 2, player: who[2], funder: who[2], shareBps: 0, won: 78 },
      ],
      fees: [44, 64, 21],
    },
  };
}
