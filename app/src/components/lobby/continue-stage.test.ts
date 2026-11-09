import { describe, expect, it } from "vitest";
import type { ChainMatch } from "@/lib/chain/read";
import { stage } from "./ContinueRail";

const m = (over: Partial<ChainMatch>) => ({ status: "active", running: null, deadline: 4_000_000_000, challenge: false, opponent: "x", game: "block-puzzle", ...over }) as unknown as ChainMatch;

describe("the Continue card stage", () => {
  it("says the result is in while a Block Burst Match with a fixed result is still paying out", () => {
    const s = stage(m({ running: "settling", fixed: "settled" }));
    expect(s).toMatchObject({ key: "paying", status: "Result in · paying out", ready: false });
  });
  it("still says Opponent found for a Match being played", () => {
    expect(stage(m({}))).toMatchObject({ key: "ready", status: "Opponent found" });
  });
  it("a Match its opener cancelled is not one to resume: it says the entry is coming back (ticket 62)", () => {
    // 3Cyp…-5 on 2026-11-09: Refunding, nobody joined, so no fixed result; its card read "Opponent found · Resume".
    const s = stage(m({ running: "refunding", opponent: null, sides: [{}, null] } as unknown as Partial<ChainMatch>));
    expect(s).toMatchObject({ key: "cancelled", action: "View", ready: false });
    expect(s.status).toMatch(/cancelled/i);
  });
});
