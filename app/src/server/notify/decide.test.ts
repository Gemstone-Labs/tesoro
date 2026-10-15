import { describe, expect, it } from "vitest";
import { DAILY_LIMIT, decide, type MatchSettledEvent, type NotifyPrefs } from "./decide";

const event = (over: Partial<MatchSettledEvent> = {}): MatchSettledEvent => ({
  kind: "match-settled",
  id: "match-settled:1:a",
  authority: "a",
  matchId: "1",
  game: "block-puzzle",
  result: "won",
  gemas: 980,
  pot: 2000,
  ...over,
});
const prefs: NotifyPrefs = { email: "p@example.com", verified: true, enabled: true };

describe("who is emailed about a settled Match", () => {
  it("emails a verified Player who has notifications on, with the result and Gemas in plain words", () => {
    const d = decide(event(), prefs, 0);
    expect(d.emails).toHaveLength(1);
    expect(d.emails[0].to).toBe("p@example.com");
    expect(d.emails[0].subject).toBe("You won your Block Puzzle Match");
    expect(d.emails[0].text).toContain("You won your Block Puzzle Match and 980 Gemas. The Pot was 2,000 Gemas.");
  });

  it("says a loss and a draw in their own words", () => {
    expect(decide(event({ result: "lost", gemas: 1000 }), prefs, 0).emails[0].text).toContain("lost your Block Puzzle Match and 1,000 Gemas");
    expect(decide(event({ result: "draw", gemas: 0 }), prefs, 0).emails[0].subject).toBe("Your Block Puzzle Match was a draw");
  });

  it("sends nothing without an address, to an unverified address, or with notifications off", () => {
    expect(decide(event(), null, 0)).toMatchObject({ emails: [], skipped: "no-address" });
    expect(decide(event(), { ...prefs, verified: false }, 0)).toMatchObject({ emails: [], skipped: "unverified" });
    expect(decide(event(), { ...prefs, enabled: false }, 0)).toMatchObject({ emails: [], skipped: "off" });
  });

  it("holds the event for the digest once the day's limit is sent", () => {
    expect(decide(event(), prefs, DAILY_LIMIT - 1).emails).toHaveLength(1);
    const d = decide(event(), prefs, DAILY_LIMIT);
    expect(d.emails).toEqual([]);
    expect(d.digest).toHaveLength(1);
  });
});
