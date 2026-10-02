import { describe, expect, it } from "vitest";
import { SIDE } from "../chain";
import { newLedger, open } from "../math";
import { botDecide, seededRng, trend } from "./bot";

const rising = Array.from({ length: 20 }, (_, i) => 100 + i * 0.2);
const falling = Array.from({ length: 20 }, (_, i) => 100 - i * 0.2);
const noisy = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 0.01 : -0.01));
const P = 100_00000000n;

describe("seededRng", () => {
  it("is deterministic and in [0, 1)", () => {
    const a = seededRng(7);
    const b = seededRng(7);
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});

describe("trend", () => {
  it("is signed with the move and zero without history", () => {
    expect(trend(rising)).toBeGreaterThan(1);
    expect(trend(falling)).toBeLessThan(-1);
    expect(Math.abs(trend(noisy))).toBeLessThan(1);
    expect(trend([1, 2])).toBe(0);
  });
});

describe("botDecide", () => {
  it("opens with the trend within its limits", () => {
    const moves = Array.from({ length: 200 }, (_, i) => botDecide(newLedger(), rising, P, seededRng(i)));
    const opens = moves.filter((m) => m?.kind === "open");
    expect(opens.length).toBeGreaterThan(30);
    for (const m of opens) {
      if (m?.kind !== "open") continue;
      expect(m.side).toBe(SIDE.long);
      expect(m.leverage).toBeGreaterThanOrEqual(2);
      expect(m.leverage).toBeLessThanOrEqual(6);
      expect(m.margin >= 100n && m.margin <= 10000n).toBe(true);
    }
    const shorts = Array.from({ length: 200 }, (_, i) => botDecide(newLedger(), falling, P, seededRng(i))).filter((m) => m?.kind === "open");
    expect(shorts.every((m) => m?.kind === "open" && m.side === SIDE.short)).toBe(true);
  });

  it("stays out of a flat market", () => {
    for (let i = 0; i < 100; i++) expect(botDecide(newLedger(), noisy, P, seededRng(i))).toBeNull();
  });

  it("closes on a reversal, a stop and a profit target", () => {
    const l = open(newLedger(), SIDE.long, 2000n, 5, P, 0);
    expect(botDecide(l, falling, P, () => 0.9)).toEqual({ kind: "close" });
    expect(botDecide(l, noisy, (P * 97n) / 100n, () => 0.9)).toEqual({ kind: "close" });
    expect(botDecide(l, noisy, (P * 102n) / 100n, () => 0.9)).toEqual({ kind: "close" });
    expect(botDecide(l, noisy, P, () => 0.9)).toBeNull();
  });
});
