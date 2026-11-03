import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { PROGRAMS } from "./mainnet-keys.ts";
import { COMPROMISED_KEY, KEEPER_CLI_FLAGS, unknownFlag, clusterOf, loadKeypair, parseArgs, programId, programOverrides, resolveKey } from "./cli-args.ts";

test("parseArgs reads values, repeated values, bare flags and positionals", () => {
  const a = parseArgs(["PROG", "--rpc", "https://x", "--program", "holdem=1", "--program", "tesoro_core=2", "--dry-run", "5"], ["dry-run"]);
  assert.equal(a.value("rpc"), "https://x");
  assert.deepEqual(a.values("program"), ["holdem=1", "tesoro_core=2"]);
  assert.equal(a.flag("dry-run"), true);
  assert.deepEqual(a.positional, ["PROG", "5"]);
  assert.throws(() => a.need("keypair"), /--keypair is required/);
});

test("--program overrides replace the repo ids and reject unknown names or bad addresses", () => {
  const id = Keypair.generate().publicKey.toBase58();
  const over = programOverrides([`tesoro_core=${id}`]);
  assert.equal(programId("tesoro_core", over).toBase58(), id);
  assert.equal(programId("holdem", over).toBase58(), PROGRAMS.holdem);
  assert.throws(() => programOverrides(["nope=1"]), /expected/);
  assert.throws(() => programOverrides(["holdem=notakey"]));
});

test("keypair files give their public key; the compromised key is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-args-"));
  const kp = Keypair.generate();
  const path = join(dir, "k.json");
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  assert.ok(loadKeypair(path).publicKey.equals(kp.publicKey));
  assert.ok(resolveKey(path).equals(kp.publicKey));
  assert.ok(resolveKey(kp.publicKey.toBase58()).equals(kp.publicKey));
  assert.throws(() => resolveKey(join(dir, "missing.json")), /neither a Solana address/);
  assert.notEqual(kp.publicKey.toBase58(), COMPROMISED_KEY);
});

test("the cluster defaults to mainnet and accepts only test or mainnet", () => {
  assert.equal(clusterOf(undefined).id, "mainnet");
  assert.equal(clusterOf("test").id, "test");
  assert.throws(() => clusterOf("devnet"), /test or mainnet/);
});

test("unknownFlag accepts the keeper CLI flags and rejects anything else, --help included", () => {
  assert.equal(unknownFlag(["--dry-run", "--rpc", "https://x", "--once"], KEEPER_CLI_FLAGS), null);
  assert.match(unknownFlag(["--help"], KEEPER_CLI_FLAGS)!, /unknown flag --help/);
  assert.match(unknownFlag(["--new-dev-key"], KEEPER_CLI_FLAGS)!, /unknown flag/);
  assert.match(unknownFlag(["stray"], KEEPER_CLI_FLAGS)!, /unexpected argument/);
});

for (const cli of ["season-run-cli.ts", "safety-sweep-cli.ts", "janitor-cli.ts"]) {
  test(`${cli} prints usage and exits 2 on an unknown flag, before reading any key`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-"));
    const keyPath = join(dir, "keeper.json");
    for (const flag of ["--help", "--bogus"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, cli), flag], { env: { ...process.env, KEEPER_KEYPAIR: keyPath }, encoding: "utf8" });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /Usage: /);
    }
    assert.equal(existsSync(keyPath), false);
  });
}
