import { describe, expect, it } from "vitest";
import { crashOdds, payoutRows, refundRows, tellRows, workedExample } from "./rules";

describe("Railcar published rules", () => {
  it("publishes the crash odds from the spec", () => {
    expect(crashOdds()).toEqual({ safeSeconds: 10, medianSeconds: 40, certainSeconds: 120, brakeSeconds: 5 });
  });

  it("publishes the Tell ranges from the spec", () => {
    expect(tellRows().map((r) => [r.range, r.lastWarningFloor])).toEqual([
      ["20 to 40 seconds", false],
      ["8 to 15 seconds", false],
      ["3 to 8 seconds", true],
    ]);
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
