/**
 * A finished ride replayed from its record: the draw gives the crash point, the Tell leads and the false screws; the
 * revealed Brakes turn track positions into ride-clock times; the Jump times give each early refund and the places. The
 * replay is held against what the chain recorded (the program's refunds, core's places), so anyone can check a ride.
 */
import { impactMs as clockAt, positionMs, refund, refundPct, ride } from "./engine";
import type { RideReason } from "./chain";

/** What the Match history keeps of a ride (Railcar's `RideSettled` plus core's places and fees). */
export interface RideRecord {
  entry: bigint;
  outcome: "placed" | "refund";
  reason: RideReason | "outage";
  /** The VRF output, null when it never came (a void ride). */
  draw: Uint8Array | null;
  /** Every counted Brake: the core seat and the ride ms of the press. */
  brakes: { seat: number; ms: number }[];
  /** Every seated Player: core seat, Account, who funded the entry, Jump order (0 aboard at Impact) and ms, the refund paid. */
  seats: { seat: number; player: string; funder: string; order: number; jumpMs: number; refund: bigint }[];
  /** Core's paid places, first place (last off) first: the seat and the forfeits it won on top of its entry. */
  places: { seat: number; won: bigint }[];
  fees: bigint;
}

export interface ReplayTell {
  stage: "screws" | "panel" | "sparks";
  /** Track ms before the wall the stage starts. */
  leadMs: number;
  /** Ride-clock ms it showed (later than its track position when a Brake ran). */
  atMs: number;
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
  /** Early-jump refund step at the Jump's track position. */
  refundPct?: number;
  /** The Player's own Brake, ride ms of the press. */
  brakeMs: number | null;
  /** Gemas the seat got back in all (entry plus winnings for a place). */
  gets: bigint;
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

/** m:ss on the ride clock. */
export const rideClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function replayRide(rec: RideRecord): RideReplay {
  const presses = rec.brakes.map((b) => b.ms).sort((a, b) => a - b);
  const brakeOf = new Map(rec.brakes.map((b) => [b.seat, b.ms]));
  const d = rec.draw ? ride(rec.draw) : null;
  const onClock = (trackMs: number) => clockAt(presses, trackMs);
  const impact = d ? onClock(d.crashMs) : null;
  const tells: ReplayTell[] = d
    ? [d.screwLeadMs, d.boltLeadMs, d.sparkLeadMs].map((leadMs, i) => ({ stage: STAGES[i], leadMs, atMs: onClock(Math.max(0, d.crashMs - leadMs)) }))
    : [];
  const base = (s: RideRecord["seats"][number]) => ({ seat: s.seat, player: s.player, funder: s.funder, brakeMs: brakeOf.get(s.seat) ?? null });
  const shown = (seat: number) => seat + 1;

  if (rec.outcome === "refund") {
    const seats = rec.seats.map((s) => ({ ...base(s), kind: "refund" as const, gets: rec.entry }));
    return { crashMs: d?.crashMs ?? null, impactMs: impact, tells, falseScrewsMs: d ? d.falseScrews.map(onClock) : [], seats, agrees: true, differences: [] };
  }

  const differences: string[] = [];
  const jumpers = rec.seats.filter((s) => s.order !== 0).sort((a, b) => a.jumpMs - b.jumpMs || a.order - b.order);
  for (const s of [...jumpers].sort((a, b) => a.seat - b.seat))
    if (impact !== null && s.jumpMs >= impact) differences.push(`Seat ${shown(s.seat)} jumped at ${rideClock(s.jumpMs)}, after the wall at ${rideClock(impact)}.`);
  // The last three off, last first.
  const placed = jumpers.slice(-3).reverse();
  const placeOf = new Map(placed.map((s, i) => [s.seat, i + 1]));
  const wonOf = new Map(rec.places.map((p) => [p.seat, p.won]));

  const seats: ReplaySeat[] = rec.seats.map((s) => {
    const place = placeOf.get(s.seat);
    if (place) return { ...base(s), kind: "place", place, jumpMs: s.jumpMs, gets: rec.entry + (wonOf.get(s.seat) ?? 0n) };
    if (s.order === 0) return { ...base(s), kind: "aboard", gets: 0n };
    const at = positionMs(presses, s.jumpMs);
    const back = refund(rec.entry, at);
    if (back !== s.refund) differences.push(`Seat ${shown(s.seat)} was refunded ${s.refund}, the replay gives ${back}.`);
    return { ...base(s), kind: "early", jumpMs: s.jumpMs, positionMs: at, refundPct: refundPct(at), gets: back };
  });
  const places = Math.max(placed.length, rec.places.length);
  for (let i = 0; i < places; i++) {
    const got = rec.places[i]?.seat;
    const want = placed[i]?.seat;
    if (got !== want) differences.push(`Place ${i + 1} went to ${got === undefined ? "nobody" : `seat ${shown(got)}`}, the replay gives ${want === undefined ? "nobody" : `seat ${shown(want)}`}.`);
  }
  return { crashMs: d?.crashMs ?? null, impactMs: impact, tells, falseScrewsMs: d ? d.falseScrews.map(onClock) : [], seats, agrees: differences.length === 0, differences };
}
