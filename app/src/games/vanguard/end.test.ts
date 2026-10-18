import { describe, expect, it } from "vitest";
import type { Battle } from "./decode";
import { endLine, endWhy } from "./end";

const over = (o: Partial<Battle>) => ({ status: 3, winner: 0, reason: 0, ...o }) as Battle;

describe("why the Match ended", () => {
  it("says nothing while the Match is on", () => {
    expect(endWhy({ status: 2, winner: 255, reason: 255 } as Battle, 0)).toBeNull();
  });

  it.each([
    [0, 0, "Supply Truck captured", "You captured their Supply Truck."],
    [0, 1, "Supply Truck captured", "They captured your Supply Truck."],
    [1, 0, "No move left", "They have no piece left that can move."],
    [1, 1, "No move left", "You have no piece left that can move."],
    [2, 0, "Out of time", "They let the clock run out three turns in a row."],
    [2, 1, "Out of time", "Your clock ran out three turns in a row."],
    [3, 0, "Limit reached", "Time or move limit reached: you had the stronger army left."],
    [3, 1, "Limit reached", "Time or move limit reached: they had the stronger army left."],
  ])("reason %i, winner seat %i, read from seat 0", (reason, winner, title, line) => {
    expect(endWhy(over({ reason, winner }), 0)).toEqual({ title, line });
  });

  it("reads the same Match from the other seat the other way round", () => {
    expect(endWhy(over({ reason: 2, winner: 0 }), 1)?.line).toBe("Your clock ran out three turns in a row.");
  });

  it("a drawn tiebreak and a cancelled Match both say the entries are refunded", () => {
    expect(endWhy(over({ reason: 3, winner: 2 }), 0)).toEqual({ title: "Draw", line: "Time or move limit reached with equal armies: both entries are refunded." });
    expect(endWhy({ status: 4, winner: 255, reason: 255 } as Battle, 0)?.line).toBe("The Match was cancelled. Both entries are refunded.");
    expect(endLine(over({ reason: 3, winner: 2 }), 1)).toContain("refunded");
  });
});
