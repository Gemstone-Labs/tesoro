import { describe, expect, it } from "vitest";
import { WAITLIST_DESCRIPTION, WAITLIST_KICKER, WAITLIST_LEDE } from "./waitlist-copy";

describe("waitlist copy", () => {
  it("says test mode is open and the waitlist gets real-money access first", () => {
    expect(WAITLIST_KICKER).toMatch(/test mode is open/i);
    for (const text of [WAITLIST_LEDE, WAITLIST_DESCRIPTION]) {
      expect(text).toMatch(/test funds/i);
      expect(text).toMatch(/real-money access first/i);
    }
  });
});
