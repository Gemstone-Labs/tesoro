import { describe, expect, it } from "vitest";
import type { HistoryRow } from "@/lib/chain/history";
import { recordAgainst, recordText, sortFriends } from "./record";

const row = (opp: string, result: HistoryRow["result"], at: number, role: HistoryRow["role"] = "player"): HistoryRow => ({
  id: String(at),
  game: "holdem",
  entry: 500,
  role,
  result,
  delta: 0,
  backing: null,
  scores: null,
  opp,
  at,
  asset: null,
});

describe("record against a Friend", () => {
  const rows = [row("B", "won", 5), row("B", "lost", 3), row("B", "won", 9), row("B", "draw", 4), row("B", "refunded", 20), row("C", "won", 7), row("B", "won", 30, "backer")];

  it("counts Matches I played against them, leaving out refunds and Backings", () => {
    expect(recordAgainst(rows, "B")).toEqual({ won: 2, lost: 1, draws: 1, last: 9 });
    expect(recordAgainst(rows, "Z")).toEqual({ won: 0, lost: 0, draws: 0, last: null });
  });

  it("reads plainly", () => {
    expect(recordText({ won: 4, lost: 2, draws: 0, last: 1 })).toBe("You 4–2");
    expect(recordText({ won: 2, lost: 2, draws: 1, last: 1 })).toBe("You 2–2, 1 draw");
    expect(recordText({ won: 0, lost: 0, draws: 2, last: 1 })).toBe("You 0–0, 2 draws");
    expect(recordText({ won: 0, lost: 0, draws: 0, last: null })).toBe("Never played");
  });

  it("sorts by the last Match together, then the newest Friend", () => {
    const friends = [
      { account: "B", since: 1 },
      { account: "C", since: 2 },
      { account: "D", since: 10 },
      { account: "E", since: 5 },
    ];
    const records = new Map([
      ["B", recordAgainst(rows, "B")],
      ["C", recordAgainst(rows, "C")],
    ]);
    expect(sortFriends(friends, records).map((f) => f.account)).toEqual(["B", "C", "D", "E"]);
  });
});
