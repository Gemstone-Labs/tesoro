import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Connection, Keypair } from "@solana/web3.js";
import { assignmentDiscriminator, assignmentSize, assignmentSource } from "./janitor-chain.ts";
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

  // 2026-11-06: 17 Assignments written before the seat-key layout (158 B Hold'em, 157 B Block Burst) cannot be decoded by the
  // client or the program (offset 173 out of range, Anchor 3003), so every nightly run failed on them. The scan now asks only for
  // the current layout's size.
  it("asks only for Assignments of the current layout's size", async () => {
    const rt = buildRuntime(settings([], { TESORO_CLUSTER: "test" } as NodeJS.ProcessEnv), new Connection("http://127.0.0.1:9"), Keypair.generate());
    assert.deepEqual([rt.duel, rt.holdem, rt.burst, rt.vanguard].map((c) => assignmentSize((c as any).program)), [222, 222, 221, 221]);
    let asked: any = null;
    const rpc = { helius: false, call: async () => ({}), getProgramAccounts: async (_p: unknown, cfg: any) => ((asked = cfg), []) };
    await assignmentSource("holdem", (rt.holdem as any).program, rpc as any, async () => "").matches();
    assert.ok(asked.filters.some((f: any) => f.dataSize === 222), JSON.stringify(asked.filters));
  });
});
