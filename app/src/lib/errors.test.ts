import { describe, expect, it } from "vitest";
import { ADVANCE_REPAID, INSTANT_UNAVAILABLE, BUSY, RATE_BELOW_PEAK, RETRY, UNCONFIRMED, UNLOCK_WAITS_FOR_TREASURY, UPDATING, YIELD_CAP_REACHED, extendFailure, plainError } from "./errors";

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
  it("turns a repaid or closed Advance into a line that offers Extend deposit", () => {
    for (const m of ["Error Message: the advance is already repaid; take another advance instead.", "Error Message: position has no open advance."]) {
      expect(plainError(extendFailure(new Error(m)))).toBe(ADVANCE_REPAID);
    }
    expect(ADVANCE_REPAID).toContain("Extend deposit");
  });
  it("leaves other failures alone", () => {
    const e = new Error("x");
    expect(extendFailure(e)).toBe(e);
  });
});

describe("Instant Redeem TreasuryShort", () => {
  it("shows the unavailable line for the program message and the raw code", () => {
    expect(plainError(new Error("failed\nProgram log: AnchorError Error Code: TreasuryShort. Error Message: the treasury cannot pay this instant redeem now."))).toBe(INSTANT_UNAVAILABLE);
    expect(plainError(new Error("Simulation failed. \nMessage: custom program error: 0x1781"))).toBe(INSTANT_UNAVAILABLE);
    expect(plainError(new Error(`tx failed ${"5".repeat(64)}: {"InstructionError":[0,{"Custom":6017}]}`))).toBe(INSTANT_UNAVAILABLE);
  });
  it("does not catch other custom errors", () => {
    expect(plainError(new Error("Simulation failed. \nMessage: custom program error: 0x1771"))).toBe(RETRY);
  });
});

describe("ticket 55: the Lock refusals and the upgrade window", () => {
  const log = (name: string, n: number) => new Error(`failed\nProgram log: AnchorError occurred. Error Code: ${name}. Error Number: ${n}. Error Message: x.`);

  it("says a Position being migrated is an update, not a failure", () => {
    const anchor = new Error("Program log: AnchorError caused by account: position. Error Code: AccountDidNotDeserialize. Error Number: 3003. Error Message: Failed to deserialize the account.");
    expect(plainError(anchor)).toBe(UPDATING);
    expect(plainError(new Error('{"InstructionError":[0,{"Custom":3003}]}'))).toBe(UPDATING);
    expect(plainError(new Error("custom program error: 0xbbb"))).toBe(UPDATING);
  });

  it("explains an Advance or Extend that waits for the rate, and the lifetime cap", () => {
    expect(plainError(log("RateBelowPeak", 6185))).toBe(RATE_BELOW_PEAK);
    expect(plainError(new Error("custom program error: 0x1829"))).toBe(RATE_BELOW_PEAK);
    expect(plainError(log("YieldCapReached", 6186))).toBe(YIELD_CAP_REACHED);
    expect(plainError(new Error('{"Custom":6186}'))).toBe(YIELD_CAP_REACHED);
    expect(plainError(log("GrowthClaimsUnfunded", 6187))).toBe(UNLOCK_WAITS_FOR_TREASURY);
  });
});
