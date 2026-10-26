import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermanentRefusals, isLegacyUnits } from "./permanent.ts";

describe("permanent refusals", () => {
  it("recognises the bridge's LegacyUnits error (6044) in a simulation message", () => {
    assert.equal(isLegacyUnits('{"InstructionError":[1,{"Custom":6044}]} Error Code: LegacyUnits.'), true);
    assert.equal(isLegacyUnits('{"InstructionError":[1,{"Custom":6044}]}'), true);
    assert.equal(isLegacyUnits('{"InstructionError":[1,{"Custom":6043}]}'), false);
    assert.equal(isLegacyUnits("blockhash not found"), false);
  });

  it("tells a subject it is skipped, and logs only the first time", () => {
    const refused = new PermanentRefusals();
    const lines: string[] = [];
    assert.equal(refused.has("claim=A"), false);
    refused.note("claim=A", "LegacyUnits", (m) => lines.push(m));
    refused.note("claim=A", "LegacyUnits", (m) => lines.push(m));
    assert.equal(refused.has("claim=A"), true);
    assert.equal(refused.has("claim=B"), false);
    assert.equal(lines.length, 1);
  });
});
