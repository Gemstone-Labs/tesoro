import { describe, expect, it } from "vitest";
import { FILL, SIDE } from "./chain";
import { chips, clock, describeFill, relativeLead, signedChips, tPlus, usd } from "./fmt";

describe("fmt", () => {
  it("formats Chips and signed PnL", () => {
    expect(chips(10000n)).toBe("10,000");
    expect(signedChips(12n)).toBe("+12");
    expect(signedChips(-12n)).toBe("−12");
    expect(signedChips(0n)).toBe("0");
  });
  it("formats clocks and USD", () => {
    expect(clock(300)).toBe("5:00");
    expect(clock(61.2)).toBe("1:02");
    expect(clock(-3)).toBe("0:00");
    expect(tPlus(75)).toBe("1:15");
    expect(usd(119.3394)).toBe("$119.34");
  });
  it("describes fills", () => {
    const f = { t: 3, kind: FILL.open, side: SIDE.long, price: 10_000_000_000n, notional: 5000n, margin: 500n, pnl: 0n, equity: 9990n };
    expect(describeFill(f)).toBe("Opened long at $100.00 (500 Chips, 5,000 notional)");
    expect(describeFill({ ...f, kind: FILL.liquidated })).toContain("Liquidated long");
  });
  it("reads the public lead from the Player's seat", () => {
    expect(relativeLead("level", 0)).toBe("Level");
    expect(relativeLead("seat0", 0)).toBe("You're ahead");
    expect(relativeLead("seat0", 1)).toBe("You're behind");
    expect(relativeLead("seat1", 1)).toBe("You're ahead");
  });
});
