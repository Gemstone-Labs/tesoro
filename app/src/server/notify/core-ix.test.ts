import { describe, expect, it } from "vitest";
import fixture from "../history/fixtures/helius-raw-devnet.json";
import type { RawTx } from "../history/webhook";
import { coreInstructionsOf } from "./core-ix";

const [START_V0, SETTLE_V0] = fixture as unknown as RawTx[];

describe("core instructions of a transaction", () => {
  it("finds the instruction core ran inside a game's settle, by name, with its accounts by name", () => {
    const names = coreInstructionsOf(START_V0).map((i) => i.name);
    expect(names).toContain("settle_match");
    const settle = coreInstructionsOf(START_V0).find((i) => i.name === "settle_match")!;
    expect(settle.account("match_state")).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("finds a top-level core instruction", () => {
    expect(coreInstructionsOf(SETTLE_V0).map((i) => i.name)).toEqual(["match_chunk"]);
  });

  it("ignores other programs' instructions, even with the same bytes", () => {
    const forged = JSON.parse(JSON.stringify(SETTLE_V0)) as RawTx;
    const ix = forged.transaction.message.instructions![1];
    ix.programIdIndex = 0;
    expect(coreInstructionsOf(forged)).toEqual([]);
  });
});
