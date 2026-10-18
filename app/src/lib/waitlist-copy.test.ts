import { describe, expect, it } from "vitest";
import { WAITLIST_DESCRIPTION, WAITLIST_KICKER } from "./waitlist-copy";

describe("waitlist copy", () => {
  it("says test mode is open and the waitlist saves a spot for launch day", () => {
    expect(WAITLIST_KICKER).toMatch(/test mode is open/i);
    expect(WAITLIST_DESCRIPTION).toMatch(/test funds/i);
    expect(WAITLIST_DESCRIPTION).toMatch(/spot for launch day/i);
    expect(WAITLIST_DESCRIPTION).not.toMatch(/real.money/i);
  });
});
