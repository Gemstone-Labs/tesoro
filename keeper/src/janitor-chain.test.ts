import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Connection, Keypair } from "@solana/web3.js";
import { assignmentDiscriminator } from "./janitor-chain.ts";
import { settings } from "./env.ts";
import { buildRuntime } from "./runtime.ts";

describe("the janitor's Assignment scan", () => {
  // Anchor camel-cases account names in `program.idl` ("assignment"); the janitor looked for "Assignment" and crashed on every Game.
  it("finds the Assignment discriminator in each Game's loaded program", () => {
    const rt = buildRuntime(settings([], { TESORO_CLUSTER: "test" } as NodeJS.ProcessEnv), new Connection("http://127.0.0.1:9"), Keypair.generate());
    const expected = [...createHash("sha256").update("account:Assignment").digest().subarray(0, 8)];
    for (const chain of [rt.duel, rt.holdem, rt.burst, rt.vanguard]) {
      assert.deepEqual(assignmentDiscriminator((chain as any).program), expected);
    }
  });
});
