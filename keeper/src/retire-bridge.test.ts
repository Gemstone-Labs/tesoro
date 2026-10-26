import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { BRIDGE, STORE } from "./lz.ts";
import { LEGACY_BRIDGE_LEN, buildBridgeIx, currentVaults, planBridge, type BridgeKind, type Row } from "./retire-bridge.ts";

const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const row = (name: string, len: number, fill: (d: Buffer) => void = () => {}): Row => {
  const data = Buffer.alloc(len);
  disc(name).copy(data);
  fill(data);
  return { pubkey: Keypair.generate().publicKey, data, lamports: 1_000 };
};
const vaultOld = Buffer.alloc(20, 0xaa);
const vaultCurrent = Buffer.alloc(20, 0xbb);
const live = (vault: Buffer) => position(212, vault);
const position = (len: number, vault: Buffer) => row("BridgePosition", len, (d) => vault.copy(d, 12));

describe("bridge retire plan", () => {
  it("its lengths are the program's constants", () => {
    const src = readFileSync(new URL("../../bridge/programs/tesoro_bridge/src/instructions/retire_legacy_account.rs", import.meta.url), "utf8");
    const nums = (name: string) => [...src.match(new RegExp(`${name}: \\[usize; \\d\\] = \\[([^\\]]*)\\]`))![1].matchAll(/\d+/g)].map((m) => Number(m[0]));
    assert.deepEqual(nums("LEGACY_BRIDGE_POSITION_LENGTHS"), LEGACY_BRIDGE_LEN.BridgePosition);
    assert.deepEqual(nums("LEGACY_CLAIM_LENGTHS"), LEGACY_BRIDGE_LEN.Claim);
    assert.deepEqual(nums("LEGACY_VAULT_TREASURY_LENGTHS"), LEGACY_BRIDGE_LEN.VaultTreasury);
  });

  it("closes each old size on abandoned vaults and leaves current-size records and other types alone", () => {
    const rows = [position(172, vaultOld), position(188, vaultOld), row("Claim", 129), row("VaultTreasury", 77, (d) => vaultOld.copy(d, 24)), position(212, vaultCurrent), row("Claim", 161), row("VaultTreasury", 101, (d) => vaultCurrent.copy(d, 24)), row("Store", 74)];
    const plan = planBridge(rows);
    assert.deepEqual(plan.items.map((i) => `${i.kind}:${i.size}`).sort(), ["BridgePosition:172", "BridgePosition:188", "Claim:129", "VaultTreasury:77"]);
    assert.equal(plan.held.length, 0);
    assert.equal(plan.left, 4);
    assert.equal(plan.held.length, 0);
  });

  it("holds back an old record that points at a vault with current records, and says so", () => {
    const rows = [live(vaultCurrent), position(172, vaultCurrent), position(188, vaultOld), row("VaultTreasury", 77, (d) => Buffer.concat([Buffer.alloc(12), vaultCurrent]).copy(d, 12))];
    assert.equal(currentVaults(rows).size, 1);
    const plan = planBridge(rows);
    assert.deepEqual(plan.items.map((i) => i.size), [188]);
    assert.deepEqual(plan.held.map((h) => h.kind as BridgeKind).sort(), ["BridgePosition", "VaultTreasury"]);
  });

  it("builds retire_legacy_account for the admin, the Store and the record", () => {
    const admin = Keypair.generate().publicKey;
    const [item] = planBridge([row("Claim", 129)]).items;
    const ix = buildBridgeIx(admin, item);
    assert.ok(ix.programId.equals(BRIDGE));
    assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [admin.toBase58(), STORE.toBase58(), item.key.toBase58()]);
    assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, false], [false, true]]);
    assert.equal(ix.data[8], 1, "Claim is LegacyKind 1");
    assert.equal(ix.data.length, 9);
  });
});
