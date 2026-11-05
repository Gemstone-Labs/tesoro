import { describe, expect, it, vi } from "vitest";
import { createHaptics } from "../block-puzzle/haptics";
import { TELL_HAPTICS } from "./brake";
import { RAILCAR_VIBRATION_KEY, createTellPlayer } from "./tells";

const memory = () => {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) } };
};

describe("Tells as sound and vibration", () => {
  it("each cue sounds and vibrates with its own pattern", () => {
    const { storage } = memory();
    const vibrate = vi.fn((_pattern: number | number[]) => true);
    const sound = vi.fn();
    const play = createTellPlayer({ sound, muted: () => false, haptics: createHaptics(() => storage, () => vibrate, RAILCAR_VIBRATION_KEY) });
    play(["screws", "sparks"]);
    expect(sound.mock.calls.map((c) => c[0])).toEqual(["screws", "sparks"]);
    expect(vibrate.mock.calls.map((c) => c[0])).toEqual([TELL_HAPTICS.screws, TELL_HAPTICS.sparks]);
  });

  it("sound off: no sound, the vibration stays; vibration off: no vibration, the sound stays", () => {
    const { storage, values } = memory();
    const vibrate = vi.fn((_pattern: number | number[]) => true);
    const sound = vi.fn();
    const haptics = createHaptics(() => storage, () => vibrate, RAILCAR_VIBRATION_KEY);
    createTellPlayer({ sound, muted: () => true, haptics })(["rattle"]);
    expect(sound).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledWith(TELL_HAPTICS.rattle);
    haptics.setEnabled(false);
    vibrate.mockClear();
    createTellPlayer({ sound, muted: () => false, haptics })(["rattle"]);
    expect(sound).toHaveBeenCalledWith("rattle");
    expect(vibrate).not.toHaveBeenCalled();
    // Railcar's vibration setting is its own, apart from Block Burst's and from sound
    expect([...values.keys()]).toEqual([RAILCAR_VIBRATION_KEY]);
  });

  it("a phone that cannot vibrate still hears the Tells", () => {
    const sound = vi.fn();
    expect(() => createTellPlayer({ sound, muted: () => false, haptics: createHaptics(() => null, () => undefined, RAILCAR_VIBRATION_KEY) })(["sparks"])).not.toThrow();
    expect(sound).toHaveBeenCalledWith("sparks");
  });
});
