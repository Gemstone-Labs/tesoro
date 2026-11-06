import { describe, expect, it } from "vitest";
import { closedWhileSeen } from "./closed-while-seen";
import type { ChainMatch } from "./read";

const seen = { status: "active", running: null, seat: 1 } as unknown as ChainMatch;

describe("a Match page whose account closed before the history row exists", () => {
  it("is settled, with its winner, when the committed table holds the Match's result", () => {
    expect(closedWhileSeen(seen, { canFinalize: true, outcome: 1 })).toMatchObject({ status: "settled", running: null, seat: 1, winner: "opener" });
    expect(closedWhileSeen(seen, { canFinalize: true, outcome: 2 })).toMatchObject({ status: "settled", winner: "joiner" });
  });
  it("names no winner for a draw or a no-show (the history row says how it settled)", () => {
    expect(closedWhileSeen(seen, { canFinalize: true, outcome: 3 })).toMatchObject({ status: "settled", winner: null });
    expect(closedWhileSeen(seen, { canFinalize: true, outcome: 4 })).toMatchObject({ status: "settled", winner: null });
  });
  it("is refunded when the table moved past the Match without running it", () => {
    expect(closedWhileSeen(seen, { canFinalize: true, outcome: null })?.status).toBe("refunded");
  });
  it("says nothing while the table does not say yet, or for a Match not seen active", () => {
    expect(closedWhileSeen(seen, { canFinalize: false, outcome: null })).toBeNull();
    expect(closedWhileSeen(seen, null)).toBeNull();
    expect(closedWhileSeen({ ...seen, status: "settled" } as ChainMatch, { canFinalize: true, outcome: 1 })).toBeNull();
    expect(closedWhileSeen(null, { canFinalize: true, outcome: 1 })).toBeNull();
  });
});
