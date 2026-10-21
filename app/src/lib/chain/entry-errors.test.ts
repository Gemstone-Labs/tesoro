import { describe, expect, it } from "vitest";
import { entryError } from "./entry-errors";

describe("entryError", () => {
  it("reads the error name from the program log", () => {
    expect(entryError(new Error("base tx failed abc\nProgram log: AnchorError ... Error Code: OnBreak. Error Number: 6154."))).toMatch(/Break/);
  });
  it("reads CoreError, Match and basket numbers", () => {
    expect(entryError(new Error('failed {"InstructionError":[0,{"Custom":6150}]}'))).toMatch(/Entry Limit/);
    expect(entryError(new Error("custom program error: 0x180a"))).toMatch(/Break/);
    expect(entryError(new Error('{"Custom":6406}'))).toMatch(/Faster Gemas|prepared|many Gemas|room/i);
    expect(entryError(new Error('{"Custom":6303}'))).toMatch(/Free transactions/);
    expect(entryError(new Error('{"Custom":6184}'))).toMatch(/room/);
  });
  it("falls back to the shared sentence for anything else", () => {
    expect(entryError(new Error("blockhash not found"))).toMatch(/busy/);
  });
});
