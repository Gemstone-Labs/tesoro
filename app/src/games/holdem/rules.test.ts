import { describe, expect, it } from "vitest";
import { PHASE, STATUS } from "./chain";
import { inPlay, legalMoves } from "./rules";

const t = (bets: [bigint, bigint], stacks: [bigint, bigint], lastRaise = 100n) => ({ bets, stacks, lastRaise });

describe("legalMoves (mirrors engine.rs)", () => {
  it("preflop small blind faces the big blind: call 50, min raise to 200 at 50/100 blinds", () => {
    const l = legalMoves(t([50n, 100n], [1450n, 1400n]), 0);
    expect(l.toCall).toBe(50n);
    expect(l.canRaise).toBe(true);
    expect(l.minTo).toBe(200n);
    expect(l.maxTo).toBe(1500n);
    expect(l.isBet).toBe(false);
  });

  it("postflop with nothing bet is a bet, min one big blind", () => {
    const l = legalMoves(t([0n, 0n], [1000n, 1000n], 200n), 1);
    expect(l.toCall).toBe(0n);
    expect(l.isBet).toBe(true);
    expect(l.minTo).toBe(200n);
  });

  it("a short stack can only raise all-in, and a short call is all-in", () => {
    const l = legalMoves(t([0n, 400n], [150n, 500n], 400n), 0);
    expect(l.toCall).toBe(150n);
    expect(l.canRaise).toBe(false);
    expect(l.maxTo).toBe(150n);
    const r = legalMoves(t([0n, 100n], [300n, 500n], 100n), 0);
    expect(r.canRaise).toBe(true);
    expect(r.minTo).toBe(200n);
  });

  it("cannot raise against an all-in opponent", () => {
    const l = legalMoves(t([0n, 800n], [1000n, 0n], 800n), 0);
    expect(l.canRaise).toBe(false);
    expect(l.toCall).toBe(800n);
  });

  it("min raise is capped at the stack when a full raise does not fit", () => {
    const l = legalMoves(t([100n, 300n], [250n, 100n], 200n), 0);
    expect(l.minTo).toBe(350n);
    expect(l.maxTo).toBe(350n);
  });
});

describe("inPlay", () => {
  it("is true only for a live Match between preflop and river", () => {
    expect(inPlay({ status: STATUS.live, phase: PHASE.flop })).toBe(true);
    expect(inPlay({ status: STATUS.live, phase: PHASE.shuffle })).toBe(false);
    expect(inPlay({ status: STATUS.over, phase: PHASE.none })).toBe(false);
  });
});
