import { describe, expect, it } from "vitest";
import { ride } from "./engine";
import { replayRide, type RideRecord } from "./replay";

/** A draw whose crash point is exactly `crashMs` (the Rust ride tests' search: words 1-3 fixed, word 0 searched). */
function drawWithCrash(crashMs: number): Uint8Array {
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

const [ANA, BEN, CY, DEE, EVE] = ["Ana", "Ben", "Cy", "Dee", "Eve"];
const seat = (s: number, player: string, order = 0, jumpMs = 0, refund = 0n) => ({ seat: s, player, funder: player, order, jumpMs, refund });

/** The spec's worked example as the chain records it: Ana off at 25 s (350 back), Cy, Ben, Dee off at 95-99 s, Eve aboard. */
const workedExample = (draw: Uint8Array): RideRecord => ({
  entry: 500n,
  outcome: "placed",
  reason: "played",
  draw,
  brakes: [],
  seats: [seat(0, ANA, 1, 25_000, 350n), seat(1, BEN, 3, 97_000), seat(2, CY, 2, 95_000), seat(3, DEE, 4, 99_000), seat(4, EVE)],
  places: [
    { seat: 3, won: 313n },
    { seat: 1, won: 130n },
    { seat: 2, won: 78n },
  ],
  fees: 129n,
});

describe("replaying a finished ride from its record", () => {
  it("the worked example: the draw's wall, the places and Ana's refund agree with what the chain paid", () => {
    const draw = drawWithCrash(104_000);
    const r = replayRide(workedExample(draw));
    expect(r.crashMs).toBe(104_000);
    // No Brakes: the wall is where the draw put it.
    expect(r.impactMs).toBe(104_000);
    expect(r.agrees).toBe(true);
    expect(r.differences).toEqual([]);
    const by = Object.fromEntries(r.seats.map((s) => [s.player, s]));
    expect([by[DEE].kind, by[DEE].place, by[DEE].gets]).toEqual(["place", 1, 813n]);
    expect([by[BEN].kind, by[BEN].place, by[BEN].gets]).toEqual(["place", 2, 630n]);
    expect([by[CY].kind, by[CY].place, by[CY].gets]).toEqual(["place", 3, 578n]);
    expect([by[ANA].kind, by[ANA].refundPct, by[ANA].gets]).toEqual(["early", 70, 350n]);
    expect([by[EVE].kind, by[EVE].gets]).toEqual(["aboard", 0n]);
  });

  it("Tells: each stage's lead from the draw, and when it showed on the ride clock", () => {
    const draw = drawWithCrash(104_000);
    const d = ride(draw);
    const r = replayRide(workedExample(draw));
    expect(r.tells.map((t) => t.leadMs)).toEqual([d.screwLeadMs, d.boltLeadMs, d.sparkLeadMs]);
    expect(r.tells.map((t) => t.atMs)).toEqual([d.screwLeadMs, d.boltLeadMs, d.sparkLeadMs].map((lead) => (lead === null ? null : 104_000 - lead)));
  });

  it("a Tell the ride did not show has no lead and no time (decisions Q39)", () => {
    // Crash points a second apart until one draw shows the panel and not the sparks, and one the other way round.
    const find = (panel: boolean, sparks: boolean) => {
      for (let crash = 60_000; crash < 110_000; crash += 1_000) {
        const d = ride(drawWithCrash(crash));
        if ((d.boltLeadMs !== null) === panel && (d.sparkLeadMs !== null) === sparks) return crash;
      }
      throw new Error("no such draw");
    };
    for (const [panel, sparks] of [[true, false], [false, true], [false, false]] as const) {
      const crash = find(panel, sparks);
      const r = replayRide(workedExample(drawWithCrash(crash)));
      expect(r.crashMs).toBe(crash);
      expect(r.tells.map((t) => t.stage)).toEqual(["screws", "panel", "sparks"]);
      expect(r.tells.map((t) => t.leadMs !== null && t.atMs !== null)).toEqual([true, panel, sparks]);
    }
  });

  it("a ride from before Tells could be absent replays with every Tell, and the same wall and refunds", () => {
    const draw = drawWithCrash(104_000);
    const now = replayRide(workedExample(draw));
    const before = replayRide({ ...workedExample(draw), everyTell: true });
    const old = ride(draw, { everyTell: true });
    expect(before.tells.map((t) => t.leadMs)).toEqual([old.screwLeadMs, old.boltLeadMs, old.sparkLeadMs]);
    expect(before.tells.every((t) => t.leadMs !== null && t.atMs !== null)).toBe(true);
    expect([before.crashMs, before.impactMs, before.agrees, before.seats]).toEqual([now.crashMs, now.impactMs, now.agrees, now.seats]);
  });

  it("a Brake moves the wall and the Tells on the clock, never on the track (the spec's Brake example)", () => {
    // Crash 52 s of track. Ana Brakes at 48 s; Ben Jumps at 50 s, Ana at 53 s; the wall comes at 54.5 s.
    const draw = drawWithCrash(52_000);
    const rec: RideRecord = {
      entry: 500n,
      outcome: "placed",
      reason: "played",
      draw,
      brakes: [{ seat: 0, ms: 48_000 }],
      seats: [seat(0, ANA, 2, 53_000), seat(1, BEN, 1, 50_000), seat(2, CY), seat(3, DEE), seat(4, EVE)],
      places: [
        { seat: 0, won: 945n },
        { seat: 1, won: 405n },
      ],
      fees: 150n,
    };
    const r = replayRide(rec);
    expect(r.impactMs).toBe(54_500);
    expect(r.agrees).toBe(true);
    const by = Object.fromEntries(r.seats.map((s) => [s.player, s]));
    expect([by[ANA].place, by[ANA].gets, by[ANA].brakeMs]).toEqual([1, 1_445n, 48_000]);
    expect([by[BEN].place, by[BEN].gets, by[BEN].brakeMs]).toEqual([2, 905n, null]);
  });

  it("an early refund is by track position: Ben at 21 s after a Brake at 15 s is at 18.5 s of track (80%)", () => {
    const draw = drawWithCrash(80_000);
    const rec: RideRecord = {
      entry: 500n,
      outcome: "placed",
      reason: "played",
      draw,
      brakes: [{ seat: 0, ms: 15_000 }],
      seats: [seat(0, ANA), seat(1, BEN, 1, 21_000, 400n), seat(2, CY, 2, 60_000), seat(3, DEE, 3, 61_000), seat(4, EVE, 4, 62_000)],
      places: [
        { seat: 4, won: 0n },
        { seat: 3, won: 0n },
        { seat: 2, won: 0n },
      ],
      fees: 0n,
    };
    const r = replayRide(rec);
    const ben = r.seats.find((s) => s.player === BEN)!;
    expect([ben.positionMs, ben.refundPct, ben.gets]).toEqual([18_500, 80, 400n]);
    expect(r.differences).toEqual([]);
  });

  it("says so when the record disagrees with the draw: a refund or a place the replay does not give", () => {
    const draw = drawWithCrash(104_000);
    const bad = workedExample(draw);
    bad.seats[0] = { ...bad.seats[0], refund: 400n };
    bad.places = [bad.places[1], bad.places[0], bad.places[2]];
    const r = replayRide(bad);
    expect(r.agrees).toBe(false);
    expect(r.differences).toEqual(["Seat 1 was refunded 400, the replay gives 350.", "Place 1 went to seat 2, the replay gives seat 4.", "Place 2 went to seat 4, the replay gives seat 2."]);
  });

  it("a Jump the record holds after the wall (which the program refuses) is a difference", () => {
    const draw = drawWithCrash(52_000);
    const rec = workedExample(draw);
    const r = replayRide(rec);
    expect(r.agrees).toBe(false);
    expect(r.differences[0]).toBe("Seat 2 jumped at 1:37, after the wall at 0:52.");
  });

  it("nobody jumped, or a void ride: every entry back, nothing to replay against", () => {
    const draw = drawWithCrash(52_000);
    const r = replayRide({ entry: 500n, outcome: "refund", reason: "nobody-jumped", draw, brakes: [], seats: [0, 1, 2, 3, 4].map((i) => seat(i, `P${i}`)), places: [], fees: 0n });
    expect(r.seats.every((s) => s.kind === "refund" && s.gets === 500n)).toBe(true);
    expect(r.impactMs).toBe(52_000);
    expect(r.agrees).toBe(true);
    const voided = replayRide({ entry: 500n, outcome: "refund", reason: "no-draw", draw: null, brakes: [], seats: [seat(0, ANA)], places: [], fees: 0n });
    expect([voided.crashMs, voided.impactMs, voided.tells]).toEqual([null, null, []]);
    expect(voided.agrees).toBe(true);
  });
});
