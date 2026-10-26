import { describe, expect, it } from "vitest";
import { END_OFFSET_SLOTS, FREEZE_OFFSET_SLOTS, HIDDEN_BEATS, HIDDEN_BEAT_SLOTS, MAX_PLAY_BATCH, PLAY_SECS, SLOTS_PER_SEC, hiddenBeatSlot, hiddenMoves } from "./live-chain";

describe("the hidden beat grid", () => {
  const t = { startSlot: 10_000 };

  it("runs from after the freeze to before the window closes, with room to land", () => {
    const first = hiddenBeatSlot(t, 0);
    const last = hiddenBeatSlot(t, HIDDEN_BEATS - 1);
    expect(first).toBeGreaterThan(t.startSlot + FREEZE_OFFSET_SLOTS);
    expect(last).toBeLessThan(t.startSlot + END_OFFSET_SLOTS - 50);
    // The last beat is after the run ends (90 s), so a move made at the final second still goes out.
    expect(last).toBeGreaterThan(t.startSlot + PLAY_SECS * SLOTS_PER_SEC);
    expect(hiddenBeatSlot(t, 1) - first).toBe(HIDDEN_BEAT_SLOTS);
  });

  it("pads every beat's moves to the same fixed length", () => {
    const m = { piece: 3, x: 1, y: 2 };
    expect(hiddenMoves([])).toHaveLength(MAX_PLAY_BATCH);
    expect(hiddenMoves([m, m, m])).toHaveLength(MAX_PLAY_BATCH);
    expect(hiddenMoves([m])[0]).toEqual(m);
    expect(hiddenMoves([m])[1]).toEqual({ piece: 0, x: 0, y: 0 });
    expect(() => hiddenMoves(Array(MAX_PLAY_BATCH + 1).fill(m))).toThrow();
  });
});
