import { describe, expect, it } from "vitest";
import { refusalLine } from "./refusal";

const program = (msg: string) => new Error(`tx failed\nError Message: ${msg}.`);

describe("the line for a declare the program refused", () => {
  it("says a late move was too late", () => {
    expect(refusalLine(program("The turn has expired"))).toBe("Too late: your turn already ran out.");
    expect(refusalLine(program("The time cap has passed"))).toBe("The time limit has passed. The Match is being counted.");
  });

  it("says a move sent while another is pending has to wait", () => {
    expect(refusalLine(program("An action is waiting to be resolved"))).toBe("Your last move is still being applied. Wait a moment.");
  });

  it("says a stale board was refreshed", () => {
    expect(refusalLine(program("Not allowed"))).toBe("That move is not possible on the current board. The board was refreshed.");
    expect(refusalLine(program("It is not your turn"))).toBe("It is not your turn. The board was refreshed.");
  });

  it("passes everything else through the shared error line", () => {
    expect(refusalLine(new Error("failed to fetch"))).toMatch(/network is busy/i);
  });
});
