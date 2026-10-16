import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { PROGRAMS } from "./mainnet-keys.ts";
import { COMPROMISED_KEY, clusterOf, loadKeypair, parseArgs, programId, programOverrides, resolveKey } from "./cli-args.ts";

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
