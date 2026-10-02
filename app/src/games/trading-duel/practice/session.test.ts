import { describe, expect, it } from "vitest";
import { FILL, SIDE } from "../chain";
import { EngineError } from "../math";
import { marked, newSession, playerOrder, stepSession } from "./session";
import { seededRng } from "./bot";

const P = 100_00000000n;
const T0 = 1_000_000;
const flat = Array.from({ length: 20 }, () => 100);

describe("practice session", () => {
  it("refuses orders before the start and after the end", () => {
    const s = newSession(T0, 60);
    expect(() => playerOrder(s, { kind: "open", side: 1, margin: 500n, leverage: 2 }, P, T0 - 1)).toThrow(EngineError);
    expect(() => playerOrder(s, { kind: "open", side: 1, margin: 500n, leverage: 2 }, P, T0 + 61_000)).toThrow(EngineError);
    expect(playerOrder(s, { kind: "open", side: 1, margin: 500n, leverage: 2 }, P, T0).me.side).toBe(SIDE.long);
  });

  it("flips by closing then opening", () => {
    let s = newSession(T0, 60);
    s = playerOrder(s, { kind: "open", side: 1, margin: 1000n, leverage: 5 }, P, T0 + 1000);
    s = playerOrder(s, { kind: "flip", side: 2, margin: 1000n, leverage: 5 }, P, T0 + 2000);
    expect(s.me.side).toBe(SIDE.short);
    expect(s.me.trades).toBe(2);
    expect(s.me.fills.map((f) => f.kind)).toEqual([FILL.open, FILL.close, FILL.open]);
  });

  it("ends at the window's close: positions are marked, higher equity wins", () => {
    let s = newSession(T0, 60);
    s = playerOrder(s, { kind: "open", side: 1, margin: 2000n, leverage: 5 }, P, T0 + 1000);
    const end = stepSession(s, (P * 103n) / 100n, T0 + 60_000, seededRng(1), flat);
    expect(end.final?.winner).toBe(0);
    expect(end.me.side).toBe(SIDE.flat);
    expect(end.me.fills.at(-1)?.kind).toBe(FILL.final);
    expect(end.final!.equity[0] > 10000n).toBe(true);
    // done: later steps change nothing
    expect(stepSession(end, P, T0 + 90_000, seededRng(1), flat)).toBe(end);
  });

  it("nobody trading is a draw", () => {
    const end = stepSession(newSession(T0, 60), P, T0 + 60_000, seededRng(1), flat);
    expect(end.final?.winner).toBe("draw");
  });

  it("liquidates your position on a step past maintenance", () => {
    let s = newSession(T0, 60);
    s = playerOrder(s, { kind: "open", side: 1, margin: 1000n, leverage: 20 }, P, T0 + 1000);
    const next = stepSession(s, (P * 90n) / 100n, T0 + 5000, seededRng(1), flat);
    expect(next.me.side).toBe(SIDE.flat);
    expect(next.me.liquidations).toBe(1);
    expect(marked(next, P)[0]).toBe(9000n);
  });

  it("the bot trades a clear trend and never breaks its limits", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i * 0.2);
    let s = newSession(T0, 300);
    const rng = seededRng(3);
    for (let i = 0; i < 100; i++) s = stepSession(s, P, T0 + 3000 + i * 2000, rng, rising);
    expect(s.bot.trades).toBeGreaterThan(0);
    for (const f of s.bot.fills) if (f.kind === FILL.open) expect(Number(f.notional / f.margin)).toBeLessThanOrEqual(6);
  });
});
