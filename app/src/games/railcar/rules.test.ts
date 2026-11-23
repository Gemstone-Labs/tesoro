import { describe, expect, it } from "vitest";
import { chanceInNextSecond, chanceRows, crashOdds, payoutRows, tellOdds, tellRows, workedExample } from "./rules";

describe("Railcar published rules (round 2, decisions Q40)", () => {
  it("publishes the crash odds from the spec: safe 5 s, half by 25 s, 9 in 10 by 41 s, 1 in about 190 past a minute, none past 2:00", () => {
    expect(crashOdds()).toEqual({ safeSeconds: 5, medianSeconds: 25, nineInTenSeconds: 41, pastMinuteOneIn: 189, certainSeconds: 120, brakeSeconds: 5 });
  });

  it("publishes the chance in the next second at 10, 25 and 45 s: 1.9, 6.9 and 13.1 in 100, rising in a straight line", () => {
    expect(chanceRows()).toEqual([
      ["10 s", "1.9 in 100"],
      ["25 s", "6.9 in 100"],
      ["45 s", "13.1 in 100"],
    ]);
    expect(chanceInNextSecond(4)).toBe(0);
    expect(chanceInNextSecond(5)).toBeGreaterThan(0);
    for (let sec = 6; sec < 100; sec++) expect(chanceInNextSecond(sec)).toBeGreaterThan(chanceInNextSecond(sec - 1));
  });

  it("publishes how often each Tell shows and its range (decisions Q39, round 2 leads)", () => {
    expect(tellRows().map((r) => [r.shows, r.range])).toEqual([
      ["Every ride", "9 to 18 seconds"],
      ["3 rides in 4", "5 to 9 seconds"],
      ["2 rides in 3", "3 to 5 seconds"],
    ]);
    expect(tellOdds()).toEqual({ sparksFloorSeconds: 3, screwsOnly: "1 ride in 12" });
  });

  it("publishes the payout split by number of Players who Jumped", () => {
    expect(payoutRows()).toEqual([
      ["Three or more", "60% / 25% / 15%"],
      ["Two", "70% / 30%"],
      ["One", "All of it"],
    ]);
  });

  it("reproduces the spec's worked example to the Gema: the Prize on the car 470, Dee 203, Ben 142, Cy 125, Ana 0, Eve 0", () => {
    const w = workedExample();
    expect([w.entry, w.pot, w.fees, w.prize, w.rest, w.anaRefund]).toEqual([100n, 500n, 30n, 470n, 170n, 0n]);
    expect(w.payouts).toEqual({ Dee: 203n, Ben: 142n, Cy: 125n, Ana: 0n, Eve: 0n });
    expect(Object.values(w.payouts).reduce((a, b) => a + b, 0n) + w.fees).toBe(500n);
  });
});
