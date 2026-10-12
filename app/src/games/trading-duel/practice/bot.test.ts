import { describe, expect, it } from "vitest";
import { seededRng } from "./bot";

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
