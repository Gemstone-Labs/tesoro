import { describe, expect, it } from "vitest";
import { closedWhileSeen } from "./closed-while-seen";
import type { ChainMatch } from "./read";

const seen = { status: "active", running: null, seat: 1 } as unknown as ChainMatch;

describe("a Match page whose account closed before the history row exists", () => {
  it("is settled when the committed table holds the Match's result", () => {
    expect(closedWhileSeen(seen, { canFinalize: true, hasResult: true })).toMatchObject({ status: "settled", running: null, seat: 1 });
  });
  it("is refunded when the table moved past the Match without running it", () => {
    expect(closedWhileSeen(seen, { canFinalize: true, hasResult: false })?.status).toBe("refunded");
  });
  it("says nothing while the table does not say yet, or for a Match not seen active", () => {
    expect(closedWhileSeen(seen, { canFinalize: false, hasResult: false })).toBeNull();
    expect(closedWhileSeen(seen, null)).toBeNull();
    expect(closedWhileSeen({ ...seen, status: "settled" } as ChainMatch, { canFinalize: true, hasResult: true })).toBeNull();
    expect(closedWhileSeen(null, { canFinalize: true, hasResult: true })).toBeNull();
  });
});
