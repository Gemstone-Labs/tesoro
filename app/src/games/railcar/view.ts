/**
 * What the one Railcar screen shows, pure: Boarding, then the Ride in place, then the Result. Built from the car's core
 * Match, its seats and the public Table; never from anything a Brake would show (no speed, distance or live refund %).
 */
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import { NO_SEAT, type TableView } from "./chain";
import { NO_TELLS, type Tells } from "./tell-state";
import { placeSharesBps } from "./engine";
import { departsAt } from "./flow";
import { planPayout, prizeOf, type FeeRates } from "./payout";
import { PLACE_WORDS } from "./words";

export interface Rider {
  /** The Player's core Account (base58). */
  account: string;
  /** Seat number shown to Players (core seat index + 1). */
  seat: number;
  me: boolean;
  /** A simulated Practice rider's name; real Players show their own name from their Account. */
  name?: string;
}

/** How a Backed seat's Gemas split: the Backer gets their entry back first, the Player their Offer share of the winnings. */
export interface RowBacking {
  /** The Backer's core Account (base58). */
  backer: string;
  /** The Player's share of the winnings (basis points). */
  shareBps: number;
  backerGets: bigint;
  playerGets: bigint;
}

/**
 * Core's split of what a Backed seat gets back (03's walk): a full refund (and a round 1 car's early refund) goes to the
 * Backer; a place returns the entry to the Backer, then the Player gets their share of the winnings, floored, and the
 * Backer the rest. An early Jump or a seat aboard at Impact gets nothing to split.
 */
export function seatSplit(a: { gets: bigint; entry: bigint; placed: boolean; shareBps: number }): { backerGets: bigint; playerGets: bigint } {
  if (!a.placed) return { backerGets: a.gets, playerGets: 0n };
  const won = a.gets > a.entry ? a.gets - a.entry : 0n;
  const playerGets = (won * BigInt(a.shareBps)) / 10_000n;
  return { backerGets: a.gets - playerGets, playerGets };
}

export interface ResultRow extends Rider {
  kind: "place" | "early" | "aboard" | "refund";
  /** 1, 2 or 3 for a place (1 = last off). */
  place?: number;
  /** Ride ms of the Jump (none for a Player aboard at Impact). */
  jumpMs?: number;
  /** Gemas back in all: entry plus winnings for a place, 0 for an early Jump or aboard at Impact (a round 1 car's early refund). */
  gets: bigint;
  /** A Backed seat: who funded it and how `gets` splits between them. */
  backing?: RowBacking;
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
      /** The Backer funding my seat (core Account, base58); null for my own Gemas or no seat. */
      myBacker: string | null;
      entry: bigint;
    }
  | {
      phase: "ride";
      /** Real ms since the ride clock started (0 until the draw arrives). */
      clockMs: number;
      /** The Tells shown so far. */
      tells: Tells;
      aboard: Rider[];
      jumped: Rider[];
      /**
       * What the last three off share: every entry less the fees, fixed when the car left (5 x 100 -> 470). It never changes
       * during the ride: a Jump moves that Player's entry onto the pile, it adds nothing to the Prize.
       */
      prize: bigint;
      /** Entries dropped on the pile so far: one per Player who Jumped. */
      pile: number;
      entry: bigint;
      /**
       * Null for a spectator. After my Jump, `after` is how many have Jumped after me so far: under three I hold a paid place
       * (place `after + 1`), from three on I get nothing. `backer`: who funded my seat.
       */
      me: { aboard: true; backer?: string } | { aboard: false; jumpMs: number; after: number; backer?: string } | null;
      /** The car left but its ride has not started in time: every entry refunds from `refundAt` (unix secs, core's). */
      delayed: { refundAt: number; refundOpen: boolean } | null;
    }
  | {
      phase: "result";
      rows: ResultRow[];
      fees: bigint;
      pot: bigint;
      entry: bigint;
      /** Ride ms when the bomb went off (the end of the ride). */
      wallMs: number;
      jumps: { account: string; ms: number; me: boolean }[];
      /** `gets` and `won` are the Player's own: under a Backing, their share; `backer` is what goes back to the Backer. */
      mine: { headline: string; gets: bigint; won: bigint; backer?: { account: string; gets: bigint } } | null;
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
  /** Ride ms of my own Brake, when I pressed it (only my page knows). */
  myBrakeMs?: number | null;
  /** The Backing this page boarded with: its seat may be closed (and its funder cleared) before the Result is read again. */
  myBacking?: { backer: string; shareBps: number } | null;
}

/** A Backed seat stays named by its funder in the frozen run (places) and on its seat until the seat closes. */
type BackingOf = (coreSeat: number, account: string, me: boolean) => { backer: string; shareBps: number } | null;

function backingsOf(f: RailcarFacts): BackingOf {
  const byAccount = new Map<string, { backer: string; shareBps: number }>();
  const run = f.core?.run;
  for (const p of run?.places ?? []) if (!p.player.equals(p.funder)) byAccount.set(p.player.toBase58(), { backer: p.funder.toBase58(), shareBps: p.playerShareBps });
  const bySeat = new Map(f.seats.filter((s) => s.seated && !s.player.equals(s.funder)).map((s) => [s.index, { backer: s.funder.toBase58(), shareBps: s.shareBps }]));
  return (coreSeat, account, me) => bySeat.get(coreSeat) ?? byAccount.get(account) ?? (me ? (f.myBacking ?? null) : null);
}

/** The draw has 90 s to land after the car leaves (Railcar's DRAW_WINDOW_SECS); past this with no ride, the car is Delayed. */
export const DELAYED_AFTER_SECS = 120;

function delayedOf(core: CarView | null, t: TableView | null, nowMs: number): { refundAt: number; refundOpen: boolean } | null {
  if (!core || core.stage !== "departed" || !core.departedAt || t?.phase === "riding") return null;
  const now = nowMs / 1000;
  if (now < core.departedAt + DELAYED_AFTER_SECS) return null;
  return { refundAt: core.refundAfter, refundOpen: now >= core.refundAfter };
}

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
      myBacker: backerOfMine(f),
      entry,
    };
  }
  if (t && t.phase === "over" && t.outcome !== "none") return withBackings(resultOf(t, f.me, f.fees, core), t, backingsOf(f));
  const seated = t?.seats.length ? t.seats.map((s) => ({ s, rider: { account: s.account.toBase58(), seat: s.seat + 1, me: s.account.toBase58() === f.me } })) : f.seats.filter((s) => s.seated).map((s) => ({ s: { order: 0, jumpMs: 0 }, rider: { account: s.player.toBase58(), seat: s.index + 1, me: s.player.toBase58() === f.me } }));
  const mine = seated.find((x) => x.rider.me);
  const n = t?.seated || core?.seated || seated.length;
  const jumped = seated.filter((x) => x.s.order !== 0);
  const after = (order: number) => jumped.filter((x) => x.s.order > order).length;
  return {
    phase: "ride",
    clockMs: t && t.phase === "riding" ? Math.max(0, f.nowMs - t.rideTs * 1000) : 0,
    tells: t?.tells ?? NO_TELLS,
    aboard: seated.filter((x) => x.s.order === 0).map((x) => x.rider),
    jumped: jumped.map((x) => x.rider),
    prize: prizeOf({ entry, seated: n, ...f.fees }),
    pile: jumped.length,
    entry,
    me: !mine ? null : { ...(mine.s.order === 0 ? { aboard: true as const } : { aboard: false as const, jumpMs: mine.s.jumpMs, after: after(mine.s.order) }), ...withBacker(backerOfMine(f)) },
    delayed: delayedOf(core, t, f.nowMs),
  };
}

/** The Backer of my seat, from the seat itself or the Backing this page boarded with. */
function backerOfMine(f: RailcarFacts): string | null {
  const s = f.me ? f.seats.find((x) => x.seated && x.player.toBase58() === f.me) : undefined;
  if (s) return s.funder.equals(s.player) ? null : s.funder.toBase58();
  return f.myBacking?.backer ?? null;
}
const withBacker = (backer: string | null) => (backer ? { backer } : {});

/** Puts each Backed seat's split on its row, and the Player's own share (and the Backer's) on `mine`. */
function withBackings(v: Extract<RailcarView, { phase: "result" }>, t: TableView, of: BackingOf): RailcarView {
  const seatOf = new Map(t.seats.map((s) => [s.account.toBase58(), s.seat]));
  const rows = v.rows.map((r) => {
    const b = of(seatOf.get(r.account) ?? -1, r.account, r.me);
    if (!b) return r;
    const split = seatSplit({ gets: r.gets, entry: v.entry, placed: r.kind === "place", shareBps: b.shareBps });
    return { ...r, backing: { backer: b.backer, shareBps: b.shareBps, ...split } };
  });
  const m = rows.find((r) => r.me);
  const mine = v.mine && m?.backing ? { ...v.mine, gets: m.backing.playerGets, won: m.backing.playerGets, backer: { account: m.backing.backer, gets: m.backing.backerGets } } : v.mine;
  return { ...v, rows, mine };
}

function resultOf(t: TableView, me: string | null, rates: FeeRates, core: CarView | null): Extract<RailcarView, { phase: "result" }> {
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
  const mine = m ? { headline: m.kind === "place" ? PLACE_WORDS[(m.place ?? 1) - 1] : m.kind === "early" ? "Jumped early" : "Aboard at the blast", gets: m.gets, won: m.kind === "place" ? m.gets - entry : 0n } : null;
  return { phase: "result", rows, fees: pay.fees.reduce((a, b) => a + b, 0n), pot, entry, wallMs: t.overMs, jumps, mine, outcome: "placed" };
}
