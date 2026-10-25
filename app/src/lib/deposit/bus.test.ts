import { describe, expect, it, vi } from "vitest";
import { onDeposit, requestDeposit } from "./bus";

describe("deposit bus", () => {
  it("hands the intent to listeners until they unsubscribe", () => {
    const cb = vi.fn();
    const off = onDeposit(cb);
    requestDeposit({ game: "holdem", need: 500 });
    requestDeposit();
    off();
    requestDeposit();
    expect(cb.mock.calls).toEqual([[{ game: "holdem", need: 500 }], [null]]);
  });
});
