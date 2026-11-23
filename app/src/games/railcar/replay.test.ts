import { describe, expect, it } from "vitest";
import { RULES_Q39, RULES_ROUND1, ride, type RulesVersion } from "./engine";
import { replayRide, type RideRecord } from "./replay";

/** A draw whose crash point under `rules` is exactly `crashMs` (the Rust ride tests' search: words 1-3 fixed, word 0 searched). */
function drawWithCrash(crashMs: number, rules?: RulesVersion): Uint8Array {
  const withWord = (w0: bigint) => {
    const d = new Uint8Array(32).fill(0x5a);
    for (let i = 0; i < 8; i++) d[i] = Number((w0 >> BigInt(8 * i)) & 0xffn);
    return d;
  };
  const crash = (w0: bigint) => ride(withWord(w0), { rules }).crashMs;
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
const seat = (s: number, player: string, order = 0, jumpMs = 0, refund = 0n) => ({ seat: s, player, funder: player, shareBps: 0, order, jumpMs, refund });

/** The spec's worked example as the chain records it: Ana off at 8 s (nothing back), Cy, Ben, Dee off at 27-29 s, Eve aboard. */
const workedExample = (draw: Uint8Array): RideRecord => ({
  entry: 100n,
  outcome: "placed",
  reason: "played",
  draw,
  brakes: [],
  seats: [seat(0, ANA, 1, 8_000), seat(1, BEN, 3, 28_000), seat(2, CY, 2, 27_000), seat(3, DEE, 4, 29_000), seat(4, EVE)],
  places: [
    { seat: 3, won: 103n, shareBps: 6_000 },
    { seat: 1, won: 42n, shareBps: 2_500 },
    { seat: 2, won: 25n, shareBps: 1_500 },
  ],
  fees: 30n,
  feeParts: [10n, 15n, 5n],
});

describe("replaying a finished ride from its record", () => {
  it("the worked example: the draw's Bomb, the places and Ana's 0 agree with what the chain paid", () => {
    const draw = drawWithCrash(30_000);
    const r = replayRide(workedExample(draw));
    expect(r.crashMs).toBe(30_000);
    // No Brakes: the Bomb goes off where the draw put it.
    expect(r.impactMs).toBe(30_000);
    expect(r.agrees).toBe(true);
    expect(r.differences).toEqual([]);
    const by = Object.fromEntries(r.seats.map((s) => [s.player, s]));
    expect([by[DEE].kind, by[DEE].place, by[DEE].gets]).toEqual(["place", 1, 203n]);
    expect([by[BEN].kind, by[BEN].place, by[BEN].gets]).toEqual(["place", 2, 142n]);
    expect([by[CY].kind, by[CY].place, by[CY].gets]).toEqual(["place", 3, 125n]);
    expect([by[ANA].kind, by[ANA].refundPct, by[ANA].gets]).toEqual(["early", 0, 0n]);
    expect([by[EVE].kind, by[EVE].gets]).toEqual(["aboard", 0n]);
  });

  it("Tells: each stage's lead from the draw, and when it showed on the ride clock", () => {
    const draw = drawWithCrash(30_000);
    const d = ride(draw);
    const r = replayRide(workedExample(draw));
    expect(r.tells.map((t) => t.leadMs)).toEqual([d.screwLeadMs, d.boltLeadMs, d.sparkLeadMs]);
    expect(r.tells.map((t) => t.atMs)).toEqual([d.screwLeadMs, d.boltLeadMs, d.sparkLeadMs].map((lead) => (lead === null ? null : 30_000 - lead)));
  });

  it("a Tell the ride did not show has no lead and no time (decisions Q39)", () => {
    // Crash points a second apart until one draw shows the panel and not the sparks, and one the other way round.
    const find = (panel: boolean, sparks: boolean) => {
      for (let crash = 30_000; crash < 80_000; crash += 1_000) {
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

  it("a Brake moves the Bomb and the Tells on the clock, never on the track (the spec's Brake example)", () => {
    // Crash 52 s of track. Ana Brakes at 48 s; Ben Jumps at 50 s, Ana at 53 s; the Bomb goes off at 54.5 s.
    const draw = drawWithCrash(52_000);
    const rec: RideRecord = {
      entry: 100n,
      outcome: "placed",
      reason: "played",
      draw,
      brakes: [{ seat: 0, ms: 48_000 }],
      seats: [seat(0, ANA, 2, 53_000), seat(1, BEN, 1, 50_000), seat(2, CY), seat(3, DEE), seat(4, EVE)],
      places: [
        { seat: 0, won: 189n },
        { seat: 1, won: 81n },
      ],
      fees: 30n,
    };
    const r = replayRide(rec);
    expect(r.impactMs).toBe(54_500);
    expect(r.agrees).toBe(true);
    const by = Object.fromEntries(r.seats.map((s) => [s.player, s]));
    expect([by[ANA].place, by[ANA].gets, by[ANA].brakeMs]).toEqual([1, 289n, 48_000]);
    expect([by[BEN].place, by[BEN].gets, by[BEN].brakeMs]).toEqual([2, 181n, null]);
  });

  it("an early Jump after a Brake: the position moves on the track, nothing comes back", () => {
    const draw = drawWithCrash(80_000);
    const rec: RideRecord = {
      entry: 100n,
      outcome: "placed",
      reason: "played",
      draw,
      brakes: [{ seat: 0, ms: 15_000 }],
      seats: [seat(0, ANA), seat(1, BEN, 1, 21_000), seat(2, CY, 2, 60_000), seat(3, DEE, 3, 61_000), seat(4, EVE, 4, 62_000)],
      places: [
        { seat: 4, won: 103n },
        { seat: 3, won: 42n },
        { seat: 2, won: 25n },
      ],
      fees: 30n,
    };
    const r = replayRide(rec);
    const ben = r.seats.find((s) => s.player === BEN)!;
    expect([ben.positionMs, ben.refundPct, ben.gets]).toEqual([18_500, 0, 0n]);
    expect(r.differences).toEqual([]);
  });

  it("says so when the record disagrees with the draw: a refund or a place the replay does not give", () => {
    const draw = drawWithCrash(30_000);
    const bad = workedExample(draw);
    bad.seats[0] = { ...bad.seats[0], refund: 40n };
    bad.places = [bad.places[1], bad.places[0], bad.places[2]];
    const r = replayRide(bad);
    expect(r.agrees).toBe(false);
    expect(r.differences).toEqual(["Seat 1 was refunded 40, the replay gives 0.", "Place 1 went to seat 2, the replay gives seat 4.", "Place 2 went to seat 4, the replay gives seat 2."]);
  });

  it("a Jump the record holds after the Bomb (which the program refuses) is a difference", () => {
    const draw = drawWithCrash(28_000);
    const rec = workedExample(draw);
    const r = replayRide(rec);
    expect(r.agrees).toBe(false);
    expect(r.differences[0]).toBe("Seat 2 jumped at 0:28, after the bomb at 0:28.");
  });

  it("nobody jumped, or a void ride: every entry back, nothing to replay against", () => {
    const draw = drawWithCrash(52_000);
    const r = replayRide({ entry: 100n, outcome: "refund", reason: "nobody-jumped", draw, brakes: [], seats: [0, 1, 2, 3, 4].map((i) => seat(i, `P${i}`)), places: [], fees: 0n });
    expect(r.seats.every((s) => s.kind === "refund" && s.gets === 100n)).toBe(true);
    expect(r.impactMs).toBe(52_000);
    expect(r.agrees).toBe(true);
    const voided = replayRide({ entry: 100n, outcome: "refund", reason: "no-draw", draw: null, brakes: [], seats: [seat(0, ANA)], places: [], fees: 0n });
    expect([voided.crashMs, voided.impactMs, voided.tells]).toEqual([null, null, []]);
    expect(voided.agrees).toBe(true);
  });
});

describe("the replay checks every amount paid, not only the order (Q40 review #5)", () => {
  it("a record that gives Dee 193 and Ben 152 (places right, total right) is a difference of 10 Gemas each", () => {
    const rec = workedExample(drawWithCrash(30_000));
    rec.places = [
      { seat: 3, won: 93n },
      { seat: 1, won: 52n },
      { seat: 2, won: 25n },
    ];
    const r = replayRide(rec);
    expect(r.agrees).toBe(false);
    expect(r.differences).toEqual(["Place 1 (seat 4) was paid 193, the replay gives 203.", "Place 2 (seat 2) was paid 152, the replay gives 142."]);
    // The replay's own amounts are the rules', not the record's.
    const by = Object.fromEntries(r.seats.map((s) => [s.player, s.gets]));
    expect([by[DEE], by[BEN], by[CY]]).toEqual([203n, 142n, 125n]);
  });

  it("the places are paid after the fees core recorded: a later Leaderboard Fee of 2% (read at settlement) is no difference, only a note", () => {
    const rec = workedExample(drawWithCrash(30_000));
    // Fees 10 / 15 / 10 = 35: the rest of the Prize is 165, split 99 + 1 left over / 41 / 24.
    rec.feeParts = [10n, 15n, 10n];
    rec.fees = 35n;
    rec.places = [
      { seat: 3, won: 100n, shareBps: 6_000 },
      { seat: 1, won: 41n, shareBps: 2_500 },
      { seat: 2, won: 24n, shareBps: 1_500 },
    ];
    const r = replayRide(rec);
    expect(r.differences).toEqual([]);
    expect(r.feeNote).toBe("Fees read when the ride settled: Platform 10, Studio 15, Leaderboard 10 (35); the published rates give 30.");
    expect(replayRide(workedExample(drawWithCrash(30_000))).feeNote).toBeNull();
  });

  it("fees above the forfeited entries are a difference (core caps them there)", () => {
    const rec = { ...workedExample(drawWithCrash(30_000)), fees: 250n, feeParts: [200n, 30n, 20n] as [bigint, bigint, bigint] };
    expect(replayRide(rec).differences).toContain("Fees were 250, more than the 200 Gemas of entries lost.");
  });

  it("each place's share is checked against the rules' 60 / 25 / 15", () => {
    const rec = workedExample(drawWithCrash(30_000));
    rec.places = rec.places.map((p, i) => ({ ...p, shareBps: [6_000, 1_500, 2_500][i] }));
    expect(replayRide(rec).differences).toEqual(["Place 2 (seat 2) took a 15% share, the rules give 25%.", "Place 3 (seat 3) took a 25% share, the rules give 15%."]);
  });

  it("a Backed place: core's place share is 60%, the Offer's 40% to the Player; the split is shown from the Offer, not compared", () => {
    const rec = workedExample(drawWithCrash(30_000));
    rec.seats[3] = { ...rec.seats[3], funder: "Fay", shareBps: 4_000 };
    rec.places[0] = { ...rec.places[0], shareBps: 6_000 };
    const r = replayRide(rec);
    expect(r.agrees).toBe(true);
    const dee = r.seats.find((s) => s.player === DEE)!;
    // 203: Fay's 100 first, then Dee 40% of the 103 won (41), Fay the rest (162).
    expect(dee.backing).toEqual({ backer: "Fay", shareBps: 4_000, backerGets: 162n, playerGets: 41n });
  });

  it("a Backed seat that Jumped early or stayed aboard: the Backer loses the entry, nothing to split", () => {
    const rec = workedExample(drawWithCrash(30_000));
    rec.seats[0] = { ...rec.seats[0], funder: "Fay", shareBps: 5_000 };
    const ana = replayRide(rec).seats.find((s) => s.player === ANA)!;
    expect(ana.backing).toEqual({ backer: "Fay", shareBps: 5_000, backerGets: 0n, playerGets: 0n });
  });

  it("a full refund is checked too: nobody jumped means no Jump, no places and no fees", () => {
    const draw = drawWithCrash(52_000);
    const rec: RideRecord = { entry: 100n, outcome: "refund", reason: "nobody-jumped", draw, brakes: [], seats: [seat(0, ANA, 1, 8_000), seat(1, BEN), seat(2, CY), seat(3, DEE), seat(4, EVE)], places: [{ seat: 0, won: 10n }], fees: 6n };
    expect(replayRide(rec).differences).toEqual(["Seat 1 jumped at 0:08, but the ride was refunded as nobody jumped.", "Fees were 6 on a full refund, the replay gives 0.", "Place 1 went to seat 1 on a full refund, the replay gives nobody."]);
  });
});

describe("a car that rode under older rules replays with its own odds and payouts", () => {
  /** Round 1's worked example as the chain recorded it: entry 500, Ana off at 25 s (350 back), Cy, Ben, Dee at 95-99 s. */
  const roundOne = (draw: Uint8Array, rules: RulesVersion): RideRecord => ({
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
    rules,
  });

  it("a Q39 car: the round 1 curve puts the wall at 104 s and Ana's 70% refund agrees with the chain", () => {
    const draw = drawWithCrash(104_000, RULES_Q39);
    const r = replayRide(roundOne(draw, RULES_Q39));
    expect([r.crashMs, r.impactMs, r.agrees]).toEqual([104_000, 104_000, true]);
    const by = Object.fromEntries(r.seats.map((s) => [s.player, s]));
    expect([by[ANA].kind, by[ANA].refundPct, by[ANA].gets]).toEqual(["early", 70, 350n]);
    expect([by[DEE].gets, by[BEN].gets, by[CY].gets]).toEqual([813n, 630n, 578n]);
    // Under today's rules the same draw is a different ride: the record would not agree.
    expect(replayRide({ ...roundOne(draw, RULES_Q39), rules: undefined }).agrees).toBe(false);
  });

  it("a round 1 car shows every Tell; a Q39 car the ones its draw shows; the wall and refunds are the same", () => {
    const draw = drawWithCrash(104_000, RULES_Q39);
    const q39 = replayRide(roundOne(draw, RULES_Q39));
    const first = replayRide(roundOne(draw, RULES_ROUND1));
    const old = ride(draw, { rules: RULES_ROUND1 });
    expect(first.tells.map((t) => t.leadMs)).toEqual([old.screwLeadMs, old.boltLeadMs, old.sparkLeadMs]);
    expect(first.tells.every((t) => t.leadMs !== null && t.atMs !== null)).toBe(true);
    expect([first.crashMs, first.impactMs, first.agrees, first.seats]).toEqual([q39.crashMs, q39.impactMs, q39.agrees, q39.seats]);
  });

  it("a round 1 early refund is by track position: Ben at 21 s after a Brake at 15 s is at 18.5 s of track (80%)", () => {
    const draw = drawWithCrash(80_000, RULES_ROUND1);
    const rec: RideRecord = {
      entry: 500n,
      outcome: "placed",
      reason: "played",
      draw,
      brakes: [{ seat: 0, ms: 15_000 }],
      seats: [seat(0, ANA), seat(1, BEN, 1, 21_000, 400n), seat(2, CY, 2, 60_000), seat(3, DEE, 3, 61_000), seat(4, EVE, 4, 62_000)],
      // Pot after Ben's 400: 2,100; fees 6% = 126 out of the 600 forfeited; 474 split 60/25/15.
      places: [
        { seat: 4, won: 285n },
        { seat: 3, won: 118n },
        { seat: 2, won: 71n },
      ],
      fees: 126n,
      rules: RULES_ROUND1,
    };
    const r = replayRide(rec);
    const ben = r.seats.find((s) => s.player === BEN)!;
    expect([ben.positionMs, ben.refundPct, ben.gets]).toEqual([18_500, 80, 400n]);
    expect(r.differences).toEqual([]);
  });
});
