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
});
