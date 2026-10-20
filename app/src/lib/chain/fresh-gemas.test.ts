import { describe, expect, it } from "vitest";
import { chainShortfall, checkGemas } from "./fresh-gemas";

describe("checkGemas", () => {
  it("passes when the Gemas cover the entry, fresh or not", () => {
    expect(checkGemas(1000n, 1000, false)).toBe("enough");
    expect(checkGemas(3357, 1000, true)).toBe("enough");
  });
  it("asks for a fresh read before believing a shortfall", () => {
    expect(checkGemas(0n, 1000, false)).toBe("recheck");
  });
  it("reports the shortfall once the read was fresh", () => {
    expect(checkGemas(999n, 1000, true)).toBe("short");
  });
});

describe("chainShortfall", () => {
  it("is a real shortfall when the balance is below the entry too", () => {
    expect(chainShortfall(300n, 500)).toBe("short");
  });
  it("says the Gemas are still landing when the balance already covers the entry", () => {
    expect(chainShortfall(512n, 500)).toBe("landing");
    expect(chainShortfall(500, 500)).toBe("landing");
  });
});
