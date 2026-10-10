import { describe, expect, it } from "vitest";
import { BUSY, RETRY, plainError } from "./errors";

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
    expect(plainError(new Error("Transaction was not confirmed in 30.00 seconds"))).toBe(BUSY);
  });
  it("names a wallet rejection", () => {
    expect(plainError(Object.assign(new Error("x"), { code: 4001 }))).toBe("You cancelled the request in your wallet.");
  });
  it("keeps our own sentences", () => {
    expect(plainError(new Error("Your opponent is still playing."))).toBe("Your opponent is still playing.");
  });
});
