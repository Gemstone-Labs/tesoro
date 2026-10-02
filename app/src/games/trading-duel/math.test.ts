import { describe, expect, it } from "vitest";
import { FILL, RULES, SIDE } from "./chain";
import { EngineError, close, equity, fillPrice, lead, liquidateIfDue, liquidationMid, newLedger, open, pnl, previewOpen, winner } from "./math";

const P = 100_00000000n; // $100

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EngineError ? e.code : "other";
  }
  return null;
};

describe("fills", () => {
  it("move against the Player by the spread", () => {
    expect(fillPrice(P, true)).toBe(P + (P * 5n) / 10_000n);
    expect(fillPrice(P, false)).toBe(P - (P * 5n) / 10_000n);
    expect(code(() => fillPrice(0n, true))).toBe("bad-price");
    expect(fillPrice(3n, true)).toBe(4n);
    expect(fillPrice(3n, false)).toBe(2n);
    expect(code(() => fillPrice(1n << 70n, true))).toBe("overflow");
  });

  it("a round trip at a flat price costs the spread", () => {
    let l = open(newLedger(), SIDE.long, 1000n, 10, P, 1);
    expect(l.cash).toBe(9000n);
    expect(l.notional).toBe(10000n);
    const c = close(l, P, 2);
    expect(c.pnl).toBe(-10n);
    expect(c.ledger.cash).toBe(9990n);
    expect(c.ledger.side).toBe(SIDE.flat);
    l = c.ledger;
    expect(l.fills.map((f) => f.kind)).toEqual([FILL.open, FILL.close]);
  });

  it("long gains and short loses when the price rises", () => {
    const up = P + P / 100n;
    const l = close(open(newLedger(), SIDE.long, 2000n, 5, P, 0), up, 1);
    const s = close(open(newLedger(), SIDE.short, 2000n, 5, P, 0), up, 1);
    expect(l.pnl > 80n && l.pnl < 100n).toBe(true);
    expect(s.pnl > -120n && s.pnl < -100n).toBe(true);
  });

  it("rounds losses away from zero", () => {
    expect(pnl(SIDE.long, 10n, 3n, 2n)).toBe(-4n);
    expect(pnl(SIDE.long, 10n, 3n, 4n)).toBe(3n);
    expect(code(() => pnl(SIDE.flat, 1n, 1n, 1n))).toBe("invalid-side");
    expect(code(() => pnl(SIDE.long, 1n, 0n, 1n))).toBe("bad-price");
  });
});

describe("bounds", () => {
  it("leverage, margin and one position at a time", () => {
    const b = newLedger();
    expect(code(() => open(b, SIDE.long, 1000n, 0, P, 0))).toBe("invalid-leverage");
    expect(code(() => open(b, SIDE.long, 1000n, 21, P, 0))).toBe("invalid-leverage");
    expect(code(() => open(b, SIDE.long, 99n, 5, P, 0))).toBe("margin-too-small");
    expect(code(() => open(b, SIDE.long, 10001n, 5, P, 0))).toBe("not-enough-chips");
    expect(code(() => open(b, SIDE.flat, 1000n, 5, P, 0))).toBe("invalid-side");
    expect(code(() => open(b, 3, 1000n, 5, P, 0))).toBe("invalid-side");
    const full = open(b, SIDE.long, 10000n, 20, P, 0);
    expect(full.notional).toBe(200000n);
    expect(full.cash).toBe(0n);
    expect(code(() => open(full, SIDE.short, 100n, 1, P, 0))).toBe("position-open");
    expect(full.trades).toBe(1);
    expect(RULES.maxLeverage).toBe(20);
  });

  it("closing nothing is an error", () => {
    expect(code(() => close(newLedger(), P, 0))).toBe("no-position");
  });

  it("does not mutate its input", () => {
    const l = newLedger();
    open(l, SIDE.long, 1000n, 2, P, 0);
    expect(l.cash).toBe(10000n);
    expect(l.fills).toHaveLength(0);
  });
});

describe("liquidation", () => {
  it("triggers at maintenance and caps the loss at the margin", () => {
    const l = open(newLedger(), SIDE.long, 1000n, 20, P, 0);
    expect(liquidateIfDue(l, (P * 96n) / 100n, 1).liquidated).toBe(false);
    const r = liquidateIfDue(l, (P * 954n) / 1000n, 2);
    expect(r.liquidated).toBe(true);
    expect(r.ledger.side).toBe(SIDE.flat);
    expect(r.ledger.liquidations).toBe(1);
    expect(r.ledger.cash >= 9000n && r.ledger.cash < 9100n).toBe(true);
    expect(r.ledger.fills.at(-1)?.kind).toBe(FILL.liquidated);
    const gap = liquidateIfDue(l, P / 2n, 1);
    expect(gap.liquidated).toBe(true);
    expect(gap.ledger.cash).toBe(9000n);
  });

  it("short liquidates on a rise", () => {
    const l = open(newLedger(), SIDE.short, 500n, 10, P, 0);
    expect(liquidateIfDue(l, (P * 105n) / 100n, 1).liquidated).toBe(false);
    expect(liquidateIfDue(l, (P * 1100n) / 1000n, 2).liquidated).toBe(true);
  });

  it("liquidationMid matches the trigger", () => {
    for (const [side, lev] of [[SIDE.long, 20], [SIDE.long, 5], [SIDE.short, 10], [SIDE.short, 2]] as const) {
      const l = open(newLedger(), side, 1000n, lev, P, 0);
      const liq = liquidationMid(l)!;
      const hair = liq / 1000n;
      const [beyond, inside] = side === SIDE.long ? [liq - hair, liq + hair] : [liq + hair, liq - hair];
      expect(liquidateIfDue(l, beyond, 1).liquidated, `${side} ${lev} beyond`).toBe(true);
      expect(liquidateIfDue(l, inside, 1).liquidated, `${side} ${lev} inside`).toBe(false);
    }
    expect(liquidationMid(newLedger())).toBeNull();
  });
});

describe("equity, lead and winner", () => {
  it("marks the open position with the closing spread", () => {
    let l = newLedger();
    expect(equity(l, P)).toBe(10000n);
    l = open(l, SIDE.long, 1000n, 10, P, 0);
    expect(equity(l, P)).toBe(9990n);
    const up = equity(l, P + P / 10n);
    expect(up > 10900n && up < 11000n).toBe(true);
  });

  it("lead has a level band", () => {
    expect(lead([10000n, 10000n])).toBe("level");
    expect(lead([10049n, 10000n])).toBe("level");
    expect(lead([10050n, 10000n])).toBe("seat0");
    expect(lead([10000n, 10500n])).toBe("seat1");
  });

  it("the higher equity wins and equal is a draw", () => {
    expect(winner([10001n, 10000n])).toBe(0);
    expect(winner([9000n, 10000n])).toBe(1);
    expect(winner([10000n, 10000n])).toBe("draw");
  });

  it("extreme values fail instead of wrapping", () => {
    const l = { ...newLedger(), cash: (1n << 64n) - 1n };
    expect(code(() => open(l, SIDE.long, (1n << 64n) - 1n, 20, P, 0))).toBe("overflow");
    expect(code(() => pnl(SIDE.long, (1n << 64n) - 1n, 1n, (1n << 64n) - 1n))).toBe("overflow");
  });

  it("previews an order", () => {
    const p = previewOpen(SIDE.long, 1000n, 10, P)!;
    expect(p.notional).toBe(10000n);
    expect(p.entry).toBe(fillPrice(P, true));
    expect(p.liquidation! < P).toBe(true);
    expect(previewOpen(SIDE.long, 1000n, 10, 0n)).toBeNull();
  });
});
