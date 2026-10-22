import { describe, expect, it } from "vitest";
import { burstErrorName } from "./live-errors";

describe("burstErrorName", () => {
  it("reads the name from the log", () => expect(burstErrorName(new Error("play failed sig: {}\nProgram log: AnchorError ... Error Code: Frozen. Error Number: 6015."))).toBe("Frozen"));
  it("reads the custom code when the rollup shows no log", () => {
    expect(burstErrorName(new Error('play failed sig: {"InstructionError":[0,{"Custom":6015}]}\n'))).toBe("Frozen");
    expect(burstErrorName(new Error('{"InstructionError":[0,{"Custom":6017}]}'))).toBe("WrongCount");
    expect(burstErrorName('"Custom":6016')).toBe("NotFrozen");
  });
  it("is null for a dropped connection or an unknown code", () => {
    expect(burstErrorName(new Error("fetch failed"))).toBeNull();
    expect(burstErrorName(new Error('"Custom":6999'))).toBeNull();
  });
});
