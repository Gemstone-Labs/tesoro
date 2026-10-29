import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/match/EnterMatch", () => ({ EnterMatch: () => null }));

import JoinChallengePage from "./page";

const open = async (match: string, search: Record<string, string> = {}) =>
  (await JoinChallengePage({ params: Promise.resolve({ match }), searchParams: Promise.resolve(search) } as never)).props;

describe("Challenge link page", () => {
  it("passes a `<opener>-<n>` Match key through to the join", async () => {
    // The link MatchView shares for a Challenge; the page once kept only all-digit ids and joined Match "0" instead.
    const key = "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU-3";
    expect(await open(key)).toMatchObject({ kind: "challenge-join", id: key });
  });

  it("keeps a Backing key and drops anything that is not one", async () => {
    const backing = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
    expect((await open("x-1", { backing })).backing).toBe(backing);
    expect((await open("x-1", { backing: "not a key" })).backing).toBeUndefined();
  });
});
