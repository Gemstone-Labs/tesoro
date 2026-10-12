import { describe, expect, it } from "vitest";
import { ASSETS } from "./chain";
import { usd, usdMid } from "./fmt";

describe("fmt", () => {
  it("formats USD with the precision the asset warrants", () => {
    expect(usd(119.3394)).toBe("$119.34");
    expect(usd(0.5)).toBe("$0.5000");
    expect(usdMid(142_50000000n, ASSETS[1])).toBe("$142.50");
  });
});
