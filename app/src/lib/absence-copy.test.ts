import { describe, expect, it } from "vitest";
import { absenceLine } from "./absence-copy";

describe("the line when a Player never checked in", () => {
  it("tells the Player who showed up that the Match is theirs, and the one who did not why they lost", () => {
    expect(absenceLine([true, false], 0)).toBe("Your opponent didn’t show up. The Match is yours.");
    expect(absenceLine([true, false], 1)).toBe("You didn’t check in in time.");
    expect(absenceLine([false, true], 1)).toBe("Your opponent didn’t show up. The Match is yours.");
  });
  it("says nobody came when nobody did, and that it costs the Platform Fee", () => {
    expect(absenceLine([false, false], 0)).toMatch(/Nobody checked in/);
    expect(absenceLine([false, false], 1)).toMatch(/Platform Fee/);
  });
});
