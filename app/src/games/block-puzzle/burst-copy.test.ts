import { describe, expect, it } from "vitest";
import { QUEUE_SIT_LINE, QUEUE_STAY_LINE, needTableLine, resultLine } from "./burst-copy";
import { REASON } from "./live-chain";

describe("Block Burst result lines", () => {
  it("tells each side of a check-in loss what happened", () => {
    expect(resultLine(REASON.absent, "won")).toBe("Your opponent didn’t show up.");
    expect(resultLine(REASON.absent, "lost")).toBe("You didn’t check in in time.");
  });
  it("says why a Match was refunded or did not count", () => {
    expect(resultLine(REASON.neither, "refunded")).toMatch(/Nobody checked in/);
    expect(resultLine(REASON.noSeed, "refunded")).toMatch(/pieces never arrived/);
    expect(resultLine(REASON.void, "refunded")).toMatch(/stopped/);
    expect(resultLine(REASON.noShow, "refunded")).toMatch(/nobody played/);
    expect(resultLine(REASON.trivial, "refunded")).toMatch(/under 5 moves/);
    expect(resultLine(REASON.draw, "draw")).toMatch(/Equal scores/);
  });
  it("says nothing extra for an ordinary result or an unknown reason", () => {
    expect(resultLine(REASON.played, "won")).toBeNull();
    expect(resultLine(null, "lost")).toBeNull();
  });
  it("tells the opener to stay, and tells a Player with no table when the entry comes back", () => {
    expect(QUEUE_SIT_LINE).toMatch(/sit first/);
    expect(QUEUE_STAY_LINE).toMatch(/leaving after you’re paired loses the Match/);
    expect(needTableLine("4:12 pm")).toContain("4:12 pm");
  });
});
