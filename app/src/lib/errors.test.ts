import { describe, expect, it } from "vitest";
import { ADVANCE_REPAID, BUSY, RETRY, UNCONFIRMED, extendFailure, plainError } from "./errors";

describe("plainError", () => {
  it("keeps the program's own message", () => {
    expect(plainError(new Error("failed\nProgram log: AnchorError ... Error Message: The Queue window has closed."))).toBe("The Queue window has closed");
  });
  it("hides signatures, logs and rollup steps", () => {
    expect(plainError(new Error(`create_match failed ${"5".repeat(64)}: {"InstructionError":[0,{"Custom":6001}]}`))).toBe(RETRY);
    expect(plainError(new Error("tee tx failed abc: {}"))).toBe(RETRY);
    expect(plainError(new Error("base tx failed Custom 0"))).toBe(RETRY);
    expect(plainError(new Error("the table has not been committed back to the base layer yet"))).toBe(RETRY);
  });
  it("turns rate limits and timeouts into a busy line", () => {
    expect(plainError(new Error("429 Too Many Requests"))).toBe(BUSY);
  });
  it("never tells the Player to retry a send that may still land", () => {
    expect(plainError(new Error("Transaction was not confirmed in 30.00 seconds"))).toBe(UNCONFIRMED);
    expect(plainError(new Error("base tx not confirmed 5abc"))).toBe(UNCONFIRMED);
    expect(plainError(new Error("Simulation failed. \nMessage: custom program error: 0x1771"))).toBe(RETRY);
  });
  it("names a wallet rejection", () => {
    expect(plainError(Object.assign(new Error("x"), { code: 4001 }))).toBe("You cancelled the request in your wallet.");
  });
  it("keeps our own sentences", () => {
    expect(plainError(new Error("Your opponent is still playing."))).toBe("Your opponent is still playing.");
  });
});

describe("extendFailure", () => {
  it("turns a repaid or closed Advance into a line that offers Take another Advance", () => {
    for (const m of ["Error Message: the advance is already repaid; take another advance instead.", "Error Message: position has no open advance."]) {
      expect(plainError(extendFailure(new Error(m)))).toBe(ADVANCE_REPAID);
    }
    expect(ADVANCE_REPAID).toContain("Take another Advance");
  });
  it("leaves other failures alone", () => {
    const e = new Error("x");
    expect(extendFailure(e)).toBe(e);
  });
});
