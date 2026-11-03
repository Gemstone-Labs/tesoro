import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_COMMANDS, ADMIN_FLAGS, assertExpectedCluster, parseAdminArgv, runAdmin, type AdminSteps } from "./admin.ts";
import { unknownFlag } from "./cli-args.ts";

describe("admin command line", () => {
  it("takes the command first, then the flags", () => {
    assert.deepEqual(parseAdminArgv(["fees", "--cluster", "test", "--dry-run"]), { command: "fees", rest: ["--cluster", "test", "--dry-run"] });
    assert.deepEqual(ADMIN_COMMANDS, ["tables", "fees", "fill", "refill", "batches"]);
  });
  it("refuses a missing or unknown command", () => {
    assert.throws(() => parseAdminArgv([]), /command/);
    assert.throws(() => parseAdminArgv(["--dry-run"]), /command/);
    assert.throws(() => parseAdminArgv(["wipe"]), /unknown command wipe/);
  });
  it("accepts its flags and rejects any other, --help included", () => {
    assert.equal(unknownFlag(["--cluster", "test", "--dry-run", "--rpc", "https://x", "--max-gemas", "5", "--game", "holdem", "--size", "9", "--history", "f.json"], ADMIN_FLAGS), null);
    assert.match(unknownFlag(["--help"], ADMIN_FLAGS)!, /unknown flag/);
    assert.match(unknownFlag(["--new-dev-key"], ADMIN_FLAGS)!, /unknown flag/);
  });
});

describe("the cluster check", () => {
  it("passes only when --cluster names the cluster the environment selects", () => {
    assert.doesNotThrow(() => assertExpectedCluster("test", {}));
    assert.doesNotThrow(() => assertExpectedCluster("mainnet", { TESORO_CLUSTER: "mainnet" }));
  });
  it("refuses a missing flag and a different cluster, so a script never runs on the wrong one by default", () => {
    assert.throws(() => assertExpectedCluster(undefined, {}), /--cluster test\|mainnet is required/);
    assert.throws(() => assertExpectedCluster("mainnet", {}), /TESORO_CLUSTER selects test, not mainnet/);
    assert.throws(() => assertExpectedCluster("test", { TESORO_CLUSTER: "mainnet" }), /selects mainnet, not test/);
    assert.throws(() => assertExpectedCluster("devnet", {}), /test or mainnet/);
  });
});

describe("running a command", () => {
  const fake = () => {
    const calls: string[] = [];
    const steps = Object.fromEntries(ADMIN_COMMANDS.map((c) => [c, async () => (calls.push(c), 1)])) as AdminSteps;
    return { calls, steps };
  };
  const opts = { dryRun: false, passes: 5, pause: async () => {}, maxGemas: 0n };

  it("runs the one step the command names", async () => {
    for (const c of ["fees", "refill", "batches"] as const) {
      const f = fake();
      await runAdmin(c, opts, f.steps);
      assert.deepEqual(f.calls, [c]);
    }
  });
  it("redeems the Treasury's repaid lines before it fills, and only with a budget", async () => {
    const f = fake();
    await runAdmin("fill", { ...opts, maxGemas: 100n }, { ...f.steps, redeem: async () => (f.calls.push("redeem"), 1) });
    assert.deepEqual(f.calls, ["redeem", "fill"]);
    await assert.rejects(runAdmin("fill", opts, f.steps), /--max-gemas/);
  });
  it("repeats table setup until a pass does nothing, at most --passes times", async () => {
    let n = 0;
    const steps = { ...fake().steps, tables: async () => (n++ < 3 ? 2 : 0) };
    await runAdmin("tables", opts, steps);
    assert.equal(n, 4);
    n = -100;
    await runAdmin("tables", { ...opts, passes: 2 }, steps);
    assert.equal(n, -98);
  });
  it("makes one pass in a dry run, where nothing is sent and the world does not move", async () => {
    let n = 0;
    await runAdmin("tables", { ...opts, dryRun: true }, { ...fake().steps, tables: async () => (n++, 7) });
    assert.equal(n, 1);
  });
});
