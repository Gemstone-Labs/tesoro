import { describe, expect, it } from "vitest";
import { crashOdds, payoutRows, refundRows, tellOdds, tellRows, workedExample } from "./rules";

describe("Railcar published rules", () => {
  it("publishes the crash odds from the spec", () => {
    expect(crashOdds()).toEqual({ safeSeconds: 10, medianSeconds: 40, certainSeconds: 120, brakeSeconds: 5 });
  });

  it("publishes how often each Tell shows and its range (decisions Q39)", () => {
    expect(tellRows().map((r) => [r.shows, r.range])).toEqual([
      ["Every ride", "20 to 40 seconds"],
      ["3 rides in 4", "8 to 15 seconds"],
      ["2 rides in 3", "3 to 8 seconds"],
    ]);
    expect(tellOdds()).toEqual({ sparksFloorSeconds: 3, screwsOnly: "1 ride in 12" });
  });

  it("publishes the Early-jump refund schedule from the spec", () => {
    expect(refundRows()).toEqual([
      ["Up to 20 s", "80%"],
      ["20 to 30 s", "70%"],
      ["30 to 40 s", "60%"],
      ["40 to 50 s", "50%"],
      ["50 to 60 s", "40%"],
      ["60 to 70 s", "30%"],
      ["70 to 80 s", "20%"],
      ["80 to 90 s", "10%"],
      ["90 to 100 s", "5%"],
      ["After 100 s", "0%"],
    ]);
  });

  it("publishes the payout split by number of Players who Jumped", () => {
    expect(payoutRows()).toEqual([
      ["Three or more", "60% / 25% / 15%"],
      ["Two", "70% / 30%"],
      ["One", "All of it"],
    ]);
  });

  it("reproduces the spec's worked example to the Gema", () => {
    const w = workedExample();
    expect(w.potAfterRefunds).toBe(2150n);
    expect(w.fees).toBe(129n);
    expect(w.rest).toBe(521n);
    expect(w.payouts).toEqual({ Dee: 813n, Ben: 630n, Cy: 578n, Ana: 350n, Eve: 0n });
  });
});
