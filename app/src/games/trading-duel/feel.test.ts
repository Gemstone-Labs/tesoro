import { describe, expect, it } from "vitest";
import { FILL, SIDE, type Fill } from "./chain";
import { fillCallout, leadChange, liquidationDistance, tickDirection } from "./feel";
import { newLedger, open } from "./math";
import { usdToMid } from "./feed";

const mid = (usd: number) => usdToMid(usd);

describe("tickDirection", () => {
  it("compares readings", () => {
    expect(tickDirection(mid(100), mid(101))).toBe("up");
    expect(tickDirection(mid(101), mid(100))).toBe("down");
    expect(tickDirection(mid(100), mid(100))).toBe("flat");
    expect(tickDirection(null, mid(100))).toBe("flat");
  });
});

describe("liquidationDistance", () => {
  const long = open(newLedger(), SIDE.long, 1000n, 10, mid(100), 0);
  const short = open(newLedger(), SIDE.short, 1000n, 10, mid(100), 0);
  it("is full when flat", () => {
    expect(liquidationDistance(newLedger(), mid(100))).toBe(1);
  });
  it("is near full at entry and 0 through liquidation (long)", () => {
    expect(liquidationDistance(long, mid(100))).toBeGreaterThan(0.9);
    expect(liquidationDistance(long, mid(50))).toBe(0);
  });
  it("shrinks as the price moves against a long", () => {
    const a = liquidationDistance(long, mid(99.5));
    const b = liquidationDistance(long, mid(95));
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(0);
  });
  it("works for shorts and clamps in profit", () => {
    expect(liquidationDistance(short, mid(104))).toBeLessThan(liquidationDistance(short, mid(101)));
    expect(liquidationDistance(short, mid(150))).toBe(0);
    expect(liquidationDistance(short, mid(80))).toBe(1);
    expect(liquidationDistance(long, mid(120))).toBe(1);
  });
});

describe("fillCallout", () => {
  const f = (o: Partial<Fill>): Fill => ({ t: 1, kind: FILL.open, side: SIDE.long, price: 0n, notional: 5000n, margin: 1000n, pnl: 0n, equity: 0n, ...o });
  it("names opens with side and leverage", () => {
    expect(fillCallout(f({}))).toEqual({ text: "▲ Long 5x opened", tone: "up" });
    expect(fillCallout(f({ side: SIDE.short }))).toEqual({ text: "▼ Short 5x opened", tone: "down" });
  });
  it("signs closes", () => {
    expect(fillCallout(f({ kind: FILL.close, pnl: 240n })).text).toBe("Closed +240 Chips");
    expect(fillCallout(f({ kind: FILL.close, pnl: -80n })).text).toBe("Closed −80 Chips");
  });
  it("calls liquidations", () => {
    expect(fillCallout(f({ kind: FILL.liquidated, pnl: -1000n }))).toEqual({ text: "Liquidated", tone: "warn" });
  });
});

describe("leadChange", () => {
  it("is relative to the seat", () => {
    expect(leadChange("level", "seat0", 0)).toBe("took");
    expect(leadChange("level", "seat0", 1)).toBe("lost");
    expect(leadChange("seat0", "seat1", 0)).toBe("lost");
    expect(leadChange("seat1", "seat0", 0)).toBe("took");
    expect(leadChange("seat0", "level", 0)).toBe("level");
    expect(leadChange("seat0", "seat0", 0)).toBeNull();
    expect(leadChange(null, "seat0", 0)).toBeNull();
  });
});
