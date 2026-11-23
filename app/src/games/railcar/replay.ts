/**
 * A finished ride replayed from its record: the draw gives the crash point, the Tell leads and the false screws; the
 * revealed Brakes turn track positions into ride-clock times; the Jump times give the places (and, on a round 1 car, each
 * early refund). Core's payout rule then gives every amount (fees, each place, a Backed seat's split). The replay is held
 * against what the chain recorded (the program's refunds, core's places and fees), so anyone can check a ride.
 */
import { RULES_CURRENT, impactMs as clockAt, placeSharesBps, positionMs, refund, refundPct, ride, type RulesVersion } from "./engine";
import type { RideReason } from "./chain";
import { RAILCAR_FEES, planPayout } from "./payout";
import { seatSplit, type RailcarView, type ResultRow, type RowBacking } from "./view";
import { PLACE_WORDS, clock as rideClock } from "./words";

/** What the Match history keeps of a ride (Railcar's `RideSettled` plus core's places and fees). */
export interface RideRecord {
  entry: bigint;
  outcome: "placed" | "refund";
  reason: RideReason | "outage";
  /** The VRF output, null when it never came (a void ride). */
  draw: Uint8Array | null;
  /** Every counted Brake: the core seat and the ride ms of the press. */
  brakes: { seat: number; ms: number }[];
  /**
   * Every seated Player: core seat, Account, who funded the entry (and, on a Backed seat, the Player's share of the
   * winnings in basis points), Jump order (0 aboard at Impact) and ms, the refund paid.
   */
  seats: { seat: number; player: string; funder: string; shareBps?: number; order: number; jumpMs: number; refund: bigint }[];
  /** Core's paid places, first place (last off) first: the seat, the forfeits it won on top of its entry, the share it split at. */
  places: { seat: number; won: bigint; shareBps?: number }[];
  fees: bigint;
  /** The rules the car left under (today's when not said): its odds, Tells and refunds replay under them. */
  rules?: RulesVersion;
}

export interface ReplayTell {
  stage: "screws" | "panel" | "sparks";
  /** Track ms before the wall the Tell starts; null when the ride did not show it. */
  leadMs: number | null;
  /** Ride-clock ms it showed (later than its track position when a Brake ran); null when the ride did not show it. */
  atMs: number | null;
}

export interface ReplaySeat {
  seat: number;
  player: string;
  funder: string;
  kind: "place" | "early" | "aboard" | "refund";
  /** 1 = last off. */
  place?: number;
  jumpMs?: number;
  /** Track ms at the Jump. */
  positionMs?: number;
  /** Early-jump refund step at the Jump's track position (0 since rules round 2). */
  refundPct?: number;
  /** The Player's own Brake, ride ms of the press. */
  brakeMs: number | null;
  /** Gemas the seat got back in all (entry plus winnings for a place), by the rules. */
  gets: bigint;
  /** A Backed seat: how `gets` splits between the Backer and the Player. */
  backing?: RowBacking;
}

export interface RideReplay {
  /** Track ms of the wall; null without a draw. */
  crashMs: number | null;
  /** Ride-clock ms of Impact once every Brake is counted; null without a draw. */
  impactMs: number | null;
  tells: ReplayTell[];
  /** Ride-clock ms of each false screw. */
  falseScrewsMs: number[];
  seats: ReplaySeat[];
  /** The record says what the replay says. */
  agrees: boolean;
  differences: string[];
}

const STAGES: ReplayTell["stage"][] = ["screws", "panel", "sparks"];

export function replayRide(rec: RideRecord): RideReplay {
  const presses = rec.brakes.map((b) => b.ms).sort((a, b) => a - b);
  const brakeOf = new Map(rec.brakes.map((b) => [b.seat, b.ms]));
  const rules = rec.rules ?? RULES_CURRENT;
  const d = rec.draw ? ride(rec.draw, { rules }) : null;
  const onClock = (trackMs: number) => clockAt(presses, trackMs);
  const impact = d ? onClock(d.crashMs) : null;
  const tells: ReplayTell[] = d
    ? [d.screwLeadMs, d.boltLeadMs, d.sparkLeadMs].map((leadMs, i) => ({ stage: STAGES[i], leadMs, atMs: leadMs === null ? null : onClock(Math.max(0, d.crashMs - leadMs)) }))
    : [];
  const base = (s: RideRecord["seats"][number]) => ({ seat: s.seat, player: s.player, funder: s.funder, brakeMs: brakeOf.get(s.seat) ?? null });
  const shown = (seat: number) => seat + 1;

  const backed = (s: RideRecord["seats"][number], gets: bigint, placed: boolean): { backing?: RowBacking } =>
    s.funder === s.player ? {} : { backing: { backer: s.funder, shareBps: s.shareBps ?? 0, ...seatSplit({ gets, entry: rec.entry, placed, shareBps: s.shareBps ?? 0 }) } };
  const differences: string[] = [];
  const replay = (seats: ReplaySeat[]): RideReplay => ({ crashMs: d?.crashMs ?? null, impactMs: impact, tells, falseScrewsMs: d ? d.falseScrews.map(onClock) : [], seats, agrees: differences.length === 0, differences });

  if (rec.outcome === "refund") {
    if (rec.reason === "nobody-jumped") for (const s of rec.seats) if (s.order !== 0) differences.push(`Seat ${shown(s.seat)} jumped at ${rideClock(s.jumpMs)}, but the ride was refunded as nobody jumped.`);
    if (rec.fees !== 0n) differences.push(`Fees were ${rec.fees} on a full refund, the replay gives 0.`);
    rec.places.forEach((p, i) => differences.push(`Place ${i + 1} went to seat ${shown(p.seat)} on a full refund, the replay gives nobody.`));
    return replay(rec.seats.map((s) => ({ ...base(s), kind: "refund" as const, gets: rec.entry, ...backed(s, rec.entry, false) })));
  }

  const jumpers = rec.seats.filter((s) => s.order !== 0).sort((a, b) => a.jumpMs - b.jumpMs || a.order - b.order);
  for (const s of [...jumpers].sort((a, b) => a.seat - b.seat))
    if (impact !== null && s.jumpMs >= impact) differences.push(`Seat ${shown(s.seat)} jumped at ${rideClock(s.jumpMs)}, after the bomb at ${rideClock(impact)}.`);
  // The last three off, last first.
  const placed = jumpers.slice(-3).reverse();
  const placeOf = new Map(placed.map((s, i) => [s.seat, i + 1]));

  const early = new Map<number, { at: number; back: bigint }>();
  for (const s of rec.seats) {
    if (s.order === 0 || placeOf.has(s.seat)) continue;
    const at = positionMs(presses, s.jumpMs);
    const back = refund(rec.entry, at, rules);
    if (back !== s.refund) differences.push(`Seat ${shown(s.seat)} was refunded ${s.refund}, the replay gives ${back}.`);
    early.set(s.seat, { at, back });
  }
  // Core's payout on the replayed refunds and places: fees on the Pot after refunds, then each place's share of the rest.
  const refunded = [...early.values()].reduce((a, e) => a + e.back, 0n);
  const pay = planPayout({ entry: rec.entry, seated: rec.seats.length, shares: placeSharesBps(placed.length).slice(0, placed.length), refunded, ...RAILCAR_FEES });
  const fees = pay.fees.reduce((a, b) => a + b, 0n);

  const seats: ReplaySeat[] = rec.seats.map((s) => {
    const place = placeOf.get(s.seat);
    if (place) {
      const gets = rec.entry + pay.won[place - 1];
      return { ...base(s), kind: "place", place, jumpMs: s.jumpMs, gets, ...backed(s, gets, true) };
    }
    if (s.order === 0) return { ...base(s), kind: "aboard", gets: 0n, ...backed(s, 0n, false) };
    const e = early.get(s.seat)!;
    return { ...base(s), kind: "early", jumpMs: s.jumpMs, positionMs: e.at, refundPct: refundPct(e.at, rules), gets: e.back, ...backed(s, e.back, false) };
  });
  const places = Math.max(placed.length, rec.places.length);
  for (let i = 0; i < places; i++) {
    const got = rec.places[i];
    const want = placed[i];
    if (got?.seat !== want?.seat) {
      differences.push(`Place ${i + 1} went to ${got === undefined ? "nobody" : `seat ${shown(got.seat)}`}, the replay gives ${want === undefined ? "nobody" : `seat ${shown(want.seat)}`}.`);
      continue;
    }
    if (got.won !== pay.won[i]) differences.push(`Place ${i + 1} (seat ${shown(got.seat)}) was paid ${rec.entry + got.won}, the replay gives ${rec.entry + pay.won[i]}.`);
    const offered = want.funder === want.player ? 0 : (want.shareBps ?? 0);
    if (got.shareBps !== undefined && want.funder !== want.player && got.shareBps !== offered)
      differences.push(`Place ${i + 1} (seat ${shown(got.seat)}) split its winnings at ${got.shareBps / 100}% to the Player, the seat was backed at ${offered / 100}%.`);
  }
  if (rec.fees !== fees) differences.push(`Fees were ${rec.fees}, the replay gives ${fees}.`);
  return replay(seats);
}

/**
 * The Result screen's model of a replayed ride, as `me` (a core Account, null for anyone else) sees it: the same podium,
 * rows and wall strip the live Result shows.
 */
export function replayView(rec: RideRecord, r: RideReplay, me: string | null): Extract<RailcarView, { phase: "result" }> {
  const rider = (s: ReplaySeat) => ({ account: s.player, seat: s.seat + 1, me: s.player === me });
  const order: ReplaySeat["kind"][] = ["place", "early", "aboard", "refund"];
  const rows: ResultRow[] = [...r.seats]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.place ?? 0) - (b.place ?? 0) || (b.jumpMs ?? 0) - (a.jumpMs ?? 0))
    .map((s) => ({ ...rider(s), kind: s.kind, place: s.place, jumpMs: s.jumpMs, gets: s.gets, ...(s.backing ? { backing: s.backing } : {}) }));
  const jumps = r.seats
    .filter((s) => s.jumpMs !== undefined)
    .sort((a, b) => (a.jumpMs ?? 0) - (b.jumpMs ?? 0))
    .map((s) => ({ account: s.player, ms: s.jumpMs ?? 0, me: s.player === me }));
  const m = rows.find((x) => x.me);
  const headline = (x: ResultRow) => (x.kind === "place" ? PLACE_WORDS[(x.place ?? 1) - 1] : x.kind === "early" ? "Jumped early" : x.kind === "aboard" ? "Aboard at the blast" : rec.reason === "nobody-jumped" ? "Nobody jumped" : "Ride void");
  return {
    phase: "result",
    rows,
    fees: rec.fees,
    pot: BigInt(rec.seats.length) * rec.entry,
    entry: rec.entry,
    wallMs: r.impactMs ?? 0,
    jumps,
    // Under a Backing the Player's own part is their share; the Backer's is shown beside it (as the live Result does).
    mine: m
      ? m.backing
        ? { headline: headline(m), gets: m.backing.playerGets, won: m.backing.playerGets, backer: { account: m.backing.backer, gets: m.backing.backerGets } }
        : { headline: headline(m), gets: m.gets, won: m.kind === "place" ? m.gets - rec.entry : 0n }
      : null,
    outcome: rec.outcome,
  };
}
