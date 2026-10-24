import { afterEach, describe, expect, it, vi } from "vitest";
import { createHaptics, hapticPattern } from "./haptics";

afterEach(() => vi.unstubAllGlobals());
describe("Block Burst haptics", () => {
  it("distinguishes placement, line, multi-line and gem feedback", () => {
    expect(hapticPattern(0, 0)).toEqual([18]);
    expect(hapticPattern(1, 0)).toEqual([24]);
    expect(hapticPattern(2, 0)).toEqual([30, 35, 18]);
    expect(hapticPattern(1, 1)).toEqual([20, 30, 35]);
  });
  it("remembers disabling separately from sound and never vibrates when disabled", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    const vibrate = vi.fn(() => true);
    const h = createHaptics(() => storage, () => vibrate);
    h.play(1, 0);
    expect(vibrate).toHaveBeenCalledWith([24]);
    h.setEnabled(false);
    vibrate.mockClear();
    h.play(2, 0);
    expect(vibrate).not.toHaveBeenCalled();
    expect(createHaptics(() => storage, () => vibrate).enabled()).toBe(false);
    expect(values.has("tesoro.sfx")).toBe(false);
  });
  it("survives unavailable storage, unsupported hardware and rejected vibration", () => {
    const h = createHaptics(() => { throw Error("storage blocked"); }, () => undefined);
    expect(h.supported()).toBe(false);
    expect(() => { h.setEnabled(false); h.play(1, 0); }).not.toThrow();
    const denied = createHaptics(() => null, () => () => { throw Error("denied"); });
    expect(() => denied.play(1, 0)).not.toThrow();
  });
});

describe("game vibration request results", () => {
  it("separates rejected, unavailable, accepted and throwing requests", () => {
    expect(createHaptics(() => null, () => undefined).play(1, 0)).toBe("unavailable");
    expect(createHaptics(() => null, () => () => false).play(1, 0)).toBe("blocked");
    expect(createHaptics(() => null, () => () => { throw Error("device"); }).play(1, 0)).toBe("error");
    const motor = vi.fn(() => true);
    expect(createHaptics(() => null, () => motor).play(1, 0)).toBe("accepted");
    expect(motor).toHaveBeenCalledWith([24]);
  });
  it("preserves a saved off preference when feedback is requested", () => {
    const h = createHaptics(() => ({getItem: () => "off", setItem: vi.fn()}), () => () => true);
    expect(h.play(1, 0)).toBe("off"); expect(h.enabled()).toBe(false);
    expect(h.play(1,0)).toBe("off");
  });
});
