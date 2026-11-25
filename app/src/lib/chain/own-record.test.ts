import { describe, expect, it } from "vitest";
import { fetchPlayerRecord } from "./backing";

const me = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe("the signed-in Player's own record on the Post a Request form", () => {
  it("is the history record Backers see, including Matches whose accounts are closed (QA 2026-11-25: 8 of 10)", async () => {
    const fetcher = answer({ [me]: { pnl: [440, -500], wins: 8, matches: 10 } });
    expect(await fetchPlayerRecord(me, fetcher)).toEqual({ matches: 10, wins: 8 });
  });

  it("is a real empty record for a Player the history has no Matches for", async () => {
    expect(await fetchPlayerRecord(me, answer({}))).toEqual({ matches: 0, wins: 0 });
  });

  it("is unknown, not 'no settled Matches', when the history is unavailable", async () => {
    expect(await fetchPlayerRecord(me, answer({ error: "Match history is not available." }, false))).toBeNull();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchPlayerRecord(me, failing)).toBeNull();
  });
});
