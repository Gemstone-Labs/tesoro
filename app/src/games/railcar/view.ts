/**
 * What the one Railcar screen shows, pure: Boarding, then the Ride in place, then the Result. Built from the car's core
 * Match, its seats and the public Table; never from anything a Brake would show (no speed, distance or live refund %).
 */
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import { NO_SEAT, type TableView } from "./chain";
import { placeSharesBps, refund as scheduleRefund } from "./engine";
import { departsAt } from "./flow";

export interface FeeRates {
  platformBps: number;
  studioBps: number;
  leaderboardBps: number;
}

/**
 * Core's `plan_payout`: fees on the Pot after refunds (the total floored once, Studio and Leaderboard floored, Platform
 * takes the rounding), capped at the forfeits Platform first; the rest split by place share, the remainder to first place.
 */
export function planPayout(a: { entry: bigint; seated: number; shares: number[]; refunded: bigint } & FeeRates): { fees: bigint[]; won: bigint[]; forfeited: bigint } {
  const unplaced = BigInt(a.seated - a.shares.length);
  const forfeited = unplaced * a.entry - a.refunded;
  const pot = BigInt(a.seated) * a.entry - a.refunded;
  const fee = (bps: number) => (pot * BigInt(bps)) / 10_000n;
  const total = fee(a.platformBps + a.studioBps + a.leaderboardBps);
  const full = [total - fee(a.studioBps) - fee(a.leaderboardBps), fee(a.studioBps), fee(a.leaderboardBps)];
  let room = forfeited;
  const fees = full.map((want) => {
    const cut = want < room ? want : room;
    room -= cut;
    return cut;
  });
  const won = a.shares.map((s) => (room * BigInt(s)) / 10_000n);
  if (won.length) won[0] += room - won.reduce((x, y) => x + y, 0n);
  return { fees, won, forfeited };
}

export interface Rider {
  /** The Player's core Account (base58). */
  account: string;
  /** Seat number shown to Players (core seat index + 1). */
  seat: number;
  me: boolean;
}

export interface ResultRow extends Rider {
  kind: "place" | "early" | "aboard" | "refund";
  /** 1, 2 or 3 for a place (1 = last off). */
  place?: number;
  /** Ride ms of the Jump (none for a Player aboard at Impact). */
  jumpMs?: number;
  /** Gemas back in all: entry plus winnings for a place, the refund for an early Jump, 0 aboard at Impact. */
  gets: bigint;
}

export type RailcarView =
  | {
      phase: "boarding";
      seated: number;
      maxSeats: number;
      minSeats: number;
      /** Whole seconds to the fixed departure time; null until 5 boarded. */
      leavesInSec: number | null;
      riders: Rider[];
      /** My seat number, null when not aboard. */
      mySeat: number | null;
      entry: bigint;
    }
  | {
      phase: "ride";
      /** Real ms since the ride clock started (0 until the draw arrives). */
      clockMs: number;
      /** Tell stages passed: 0 none, 1 screws, 2 bolt and panel, 3 sparks and creak. */
      tell: number;
      aboard: Rider[];
      jumped: Rider[];
      /** Every entry in the car. */
      stake: bigint;
      entry: bigint;
      /** Null for a spectator. */
      me: { aboard: true } | { aboard: false; jumpMs: number; back: bigint } | null;
    }
  | {
      phase: "result";
      rows: ResultRow[];
      fees: bigint;
      pot: bigint;
      entry: bigint;
      /** Ride ms where the wall stood (the end of the ride). */
      wallMs: number;
      jumps: { account: string; ms: number; me: boolean }[];
      mine: { headline: string; gets: bigint; won: bigint } | null;
      outcome: "placed" | "refund";
    };

export interface RailcarFacts {
  /** My core Account (base58), null signed out. */
  me: string | null;
  core: CarView | null;
  /** Every seat of the car (empty ones too). */
  seats: SeatView[];
  /** The Table while it holds this car (null before the ride starts on it). */
  table: TableView | null;
  fees: FeeRates;
  nowMs: number;
}

const PLACE_WORDS = ["Last off", "Second-last off", "Third-last off"];

export function railcarView(f: RailcarFacts): RailcarView {
  const core = f.core;
  const entry = core?.entry ?? f.table?.entry ?? 500n;
  const t = f.table;
  if (!t && core?.stage === "boarding") {
    const riders = f.seats.filter((s) => s.seated).map((s) => ({ account: s.player.toBase58(), seat: s.index + 1, me: s.player.toBase58() === f.me }));
    const at = departsAt(core);
    return {
      phase: "boarding",
      seated: core.seated,
      maxSeats: core.maxSeats,
      minSeats: core.minSeats,
      leavesInSec: at === null ? null : Math.max(0, Math.ceil(at - f.nowMs / 1000)),
      riders,
      mySeat: riders.find((r) => r.me)?.seat ?? null,
      entry,
    };
  }
  if (t && t.phase === "over" && t.outcome !== "none") return resultOf(t, f.me, f.fees, core);
  const seated = t?.seats.length ? t.seats.map((s) => ({ s, rider: { account: s.account.toBase58(), seat: s.seat + 1, me: s.account.toBase58() === f.me } })) : f.seats.filter((s) => s.seated).map((s) => ({ s: { order: 0, jumpMs: 0 }, rider: { account: s.player.toBase58(), seat: s.index + 1, me: s.player.toBase58() === f.me } }));
  const mine = seated.find((x) => x.rider.me);
  const n = BigInt(t?.seated || core?.seated || seated.length);
  return {
    phase: "ride",
    clockMs: t && t.phase === "riding" ? Math.max(0, f.nowMs - t.rideTs * 1000) : 0,
    tell: t?.tell ?? 0,
    aboard: seated.filter((x) => x.s.order === 0).map((x) => x.rider),
    jumped: seated.filter((x) => x.s.order !== 0).map((x) => x.rider),
    stake: n * entry,
    entry,
    me: !mine ? null : mine.s.order === 0 ? { aboard: true } : { aboard: false, jumpMs: mine.s.jumpMs, back: earlyBack(entry, mine.s.jumpMs) },
  };
}

/** What an early Jump gets back: the published schedule at the Jump's position (no Brakes yet: position = ride time). */
const earlyBack = (entry: bigint, jumpMs: number) => scheduleRefund(entry, jumpMs);

function resultOf(t: TableView, me: string | null, rates: FeeRates, core: CarView | null): RailcarView {
  const entry = t.entry;
  const rider = (i: number) => {
    const s = t.seats[i];
    return { account: s.account.toBase58(), seat: s.seat + 1, me: s.account.toBase58() === me };
  };
  const pot = BigInt(t.seated) * entry;
  const jumps = t.seats
    .filter((s) => s.order !== 0)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ account: s.account.toBase58(), ms: s.jumpMs, me: s.account.toBase58() === me }));
  if (t.outcome === "refund") {
    const rows: ResultRow[] = t.seats.map((s) => ({ ...rider(s.tableSeat), kind: "refund", gets: entry }));
    const headline = t.reason === "nobody-jumped" ? "Nobody jumped" : "Ride void";
    const m = rows.find((r) => r.me);
    return { phase: "result", rows, fees: 0n, pot, entry, wallMs: t.overMs, jumps, mine: m ? { headline, gets: entry, won: 0n } : null, outcome: "refund" };
  }
  const placed = t.places.filter((p) => p !== NO_SEAT);
  const refunded = t.seats.reduce((a, s) => a + s.refund, 0n);
  // Once core froze the result its run holds the real numbers; before that the same rule gives them.
  const frozen = core && core.run?.nPlaces === placed.length && placed.length > 0 && core.stage !== "boarding" && core.stage !== "departed";
  const pay = frozen ? { fees: core.run.fees, won: core.run.places.map((p) => p.won) } : planPayout({ entry, seated: t.seated, shares: placeSharesBps(placed.length).slice(0, placed.length), refunded, ...rates });
  const rows: ResultRow[] = placed.map((p, k) => ({ ...rider(p), kind: "place", place: k + 1, jumpMs: t.seats[p].jumpMs, gets: entry + pay.won[k] }));
  const early = t.seats.filter((s) => s.order !== 0 && !placed.includes(s.tableSeat)).sort((a, b) => b.order - a.order);
  rows.push(...early.map((s) => ({ ...rider(s.tableSeat), kind: "early" as const, jumpMs: s.jumpMs, gets: s.refund })));
  rows.push(...t.seats.filter((s) => s.order === 0).map((s) => ({ ...rider(s.tableSeat), kind: "aboard" as const, gets: 0n })));
  const m = rows.find((r) => r.me);
  const mine = m ? { headline: m.kind === "place" ? PLACE_WORDS[(m.place ?? 1) - 1] : m.kind === "early" ? "Jumped early" : "Aboard at Impact", gets: m.gets, won: m.kind === "place" ? m.gets - entry : 0n } : null;
  return { phase: "result", rows, fees: pay.fees.reduce((a, b) => a + b, 0n), pot, entry, wallMs: t.overMs, jumps, mine, outcome: "placed" };
}
