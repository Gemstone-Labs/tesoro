import { describe, expect, it } from "vitest";
import { refusalLine } from "./refusal";

const program = (msg: string) => new Error(`tx failed\nError Message: ${msg}.`);

describe("the line for a declare the program refused", () => {
  it("says a late move was too late", () => {
    expect(refusalLine(program("The turn has expired"))).toBe("Too late: your turn ran out.");
    expect(refusalLine(program("The time cap has passed"))).toBe("Time limit passed.");
  });

  it("says a move sent while another is pending has to wait", () => {
    expect(refusalLine(program("An action is waiting to be resolved"))).toBe("Last move still applying.");
  });

  it("says a stale board was refreshed", () => {
    expect(refusalLine(program("Not allowed"))).toBe("Move not possible.");
    expect(refusalLine(program("It is not your turn"))).toBe("Not your turn.");
  });

  it("passes everything else through the shared error line", () => {
    expect(refusalLine(new Error("failed to fetch"))).toMatch(/network is busy/i);
  });
});
