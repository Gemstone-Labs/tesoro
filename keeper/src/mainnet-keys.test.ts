import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { MAINNET_PROGRAMS, buildPlan, describe, setUpgradeAuthorityIx, type SolanaStep } from "./mainnet-keys.ts";

const k = () => Keypair.generate().publicKey;
const base = () => ({ vault: k(), current: k(), oracle: k(), platformBps: 200 });

test("the plan moves every mainnet program's upgrade authority to the vault and leaves sim_lst out", () => {
  const input = base();
  const steps = buildPlan(input);
  const moves = steps.filter((s): s is SolanaStep => s.kind === "solana" && s.ix.programId.toBase58().startsWith("BPFLoader"));
  assert.equal(moves.length, MAINNET_PROGRAMS.length);
  for (const m of moves) {
    assert.ok(m.ix.keys[1].isSigner && m.ix.keys[1].pubkey.equals(input.current));
    assert.ok(!m.ix.keys[2].isSigner && m.ix.keys[2].pubkey.equals(input.vault));
    assert.deepEqual([...m.ix.data], [4, 0, 0, 0]);
  }
  assert.ok(!buildPlan({ ...input }).some((s) => s.title.startsWith("sim_lst")));
  assert.ok(buildPlan({ ...input, includeSimLst: true }).some((s) => s.title.startsWith("sim_lst")));
});

test("authority-gated rotations come before the upgrade authority moves", () => {
  const steps = buildPlan(base());
  const at = (t: string) => steps.findIndex((s) => s.title.includes(t));
  assert.ok(at("rotate Config.admin") < at("tesoro_core: upgrade authority"));
  assert.ok(at("tesoro_bridge: rotate") < at("tesoro_bridge: upgrade authority"));
  assert.ok(at("set the oracle key") < at("rotate Config.admin"));
});

test("roles must not collapse onto one key", () => {
  const b = base();
  assert.throws(() => buildPlan({ ...b, vault: b.current }), /different address/);
  assert.throws(() => buildPlan({ ...b, oracle: b.current }), /own hot key/);
  assert.throws(() => buildPlan({ ...b, oracle: b.vault }), /own hot key/);
  assert.throws(() => buildPlan({ ...b, invite: b.oracle }), /--invite must differ/);
  assert.throws(() => buildPlan({ ...b, platformBps: 20_000 }), /platform-bps/);
});

test("EVM steps set the delegate before transferring ownership", () => {
  const evm = [{ chain: "ethereum" as const, vault: "0x" + "11".repeat(20), rpc: "https://rpc", newOwner: "0x" + "22".repeat(20) }];
  const step = buildPlan({ ...base(), evm }).find((s) => s.kind === "evm");
  assert.ok(step && step.kind === "evm");
  assert.ok(step.command.indexOf("setDelegate") < step.command.indexOf("transferOwnership"));
});

test("describe prints signer, accounts and data without any key material", () => {
  const out = buildPlan(base()).map(describe).join("\n");
  assert.match(out, /data \(base64\)/);
  assert.ok(!/secret|private key file/i.test(out.replace(/CURRENT_OWNER_KEY/g, "")));
  assert.equal(setUpgradeAuthorityIx(k(), k(), k()).keys.length, 3);
});

test("an Invite key adds the vault-signed set_invite_gate step, after the admin moved", () => {
  const input = { ...base(), invite: k() };
  const steps = buildPlan(input);
  const i = steps.findIndex((s) => s.title.includes("Invite gate"));
  assert.ok(i > steps.findIndex((s) => s.title.includes("rotate Config.admin")));
  const step = steps[i] as SolanaStep;
  assert.equal(step.signer, "vault");
  assert.ok(step.ix.keys[0].isSigner && step.ix.keys[0].pubkey.equals(input.vault));
  assert.equal(step.ix.data[8], 1);
  assert.deepEqual([...step.ix.data.subarray(9, 41)], [...input.invite.toBytes()]);
  assert.ok(!buildPlan(base()).some((s) => s.title.includes("Invite gate")));
});
