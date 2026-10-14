import { describe, expect, it } from "vitest";
import { checkGemas } from "./fresh-gemas";

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
