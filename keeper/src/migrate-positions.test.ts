import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  MIGRATE_FEE_LAMPORTS,
  classify,
  excessClaims,
  gates,
  migrateIx,
  migrateTxs,
  requiredLamports,
} from "./migrate-positions.ts";
import { coreProgram } from "./retire-old.ts";

const fixtures = JSON.parse(readFileSync(new URL("../../app/src/lib/chain/position-size.fixtures.json", import.meta.url), "utf8"));
const devnet = (k: "some" | "noneStale") => Buffer.from(fixtures[k].data, "base64");

/** A stake Position image of `len` bytes: stake_rate_open, custody, paid and held set (open_advance None). */
function stake(len: 235 | 243, over: { custody: bigint; paid: bigint; heldWhole: bigint }): Buffer {
  const d = Buffer.alloc(len);
  d.set(devnet("noneStale").subarray(0, 8));
  d[122] = 0;
  const o = 123 + 16; // after open_advance (None), last_seq, cumulative_yield
  d.writeBigUInt64LE(over.custody, o + 32);
  d.writeBigUInt64LE(1_200_000_000_000n, o + 42);
  const held = over.heldWhole << 32n;
  d.writeBigUInt64LE(held & 0xffff_ffff_ffff_ffffn, o + 50);
  d.writeBigUInt64LE(held >> 64n, o + 58);
  d.writeBigUInt64LE(over.paid, o + 82);
  return d;
}
const row = (data: Buffer) => ({ pubkey: Keypair.generate().publicKey, data });

describe("migrate_position sweep (ticket 55)", () => {
  it("counts 235-byte Positions to migrate, by kind, and leaves 243-byte ones", () => {
    const rows = [row(devnet("some")), row(devnet("noneStale")), row(stake(235, { custody: 10n, paid: 0n, heldWhole: 0n })), row(stake(243, { custody: 10n, paid: 0n, heldWhole: 0n }))];
    const c = classify(rows);
    assert.equal(c.legacy.length, 3);
    assert.equal(c.legacyStake.length, 1);
    assert.equal(c.current, 1);
  });

  it("finds legacy stake Locks whose holders are owed more than their custody holds (design-v4 5a)", () => {
    const over = row(stake(235, { custody: 10_000_000_000n, paid: 1n, heldWhole: 10_348_956_599n }));
    const fine = row(stake(235, { custody: 10_000_000_000n, paid: 0n, heldWhole: 9_000_000_000n }));
    const found = excessClaims([over, fine]);
    assert.deepEqual(found.map((e) => [e.position.toBase58(), e.excess]), [[over.pubkey.toBase58(), 348_956_600n]]);
  });

  it("needs the upgrade buffer's rent plus the rent of 8 bytes (and a fee share) per Position", () => {
    // Devnet and mainnet rents read 2026-10-28: 1,884,680 - 1,844,040 = 40,640 lamports for 8 bytes.
    assert.equal(requiredLamports(83, 16_003_427_200n, 40_640n), 16_003_427_200n + 83n * (40_640n + MIGRATE_FEE_LAMPORTS));
  });

  it("refuses to start while another program upgrade runs, the deployer is short, or mainnet has stake Positions", () => {
    const ok = { otherUpgrades: [], deployerLamports: requiredLamports(10, 5n, 40_640n), required: requiredLamports(10, 5n, 40_640n), mainnetStake: 0 };
    assert.deepEqual(gates(ok), []);
    assert.match(gates({ ...ok, otherUpgrades: ["123 solana program deploy x"] }).join(), /another program upgrade/);
    assert.match(gates({ ...ok, deployerLamports: ok.required - 1n }).join(), /deployer holds/);
    assert.match(gates({ ...ok, mainnetStake: 2 }).join(), /mainnet has 2 stake Positions/);
  });

  it("builds one admin-signed migrate_position per Position, a few per transaction", async () => {
    const program = coreProgram();
    const admin = Keypair.generate().publicKey;
    const keys = Array.from({ length: 23 }, () => Keypair.generate().publicKey);
    const ix = await migrateIx(program, admin, keys[0]);
    const name = (program.idl as any).instructions.find((i: any) => Buffer.from(i.discriminator).equals(ix.data.subarray(0, 8))).name;
    assert.equal(name, "migratePosition");
    assert.ok(ix.keys[0].pubkey.equals(admin) && ix.keys[0].isSigner && ix.keys[0].isWritable);
    assert.ok(ix.keys[2].pubkey.equals(keys[0]) && ix.keys[2].isWritable);
    const txs = migrateTxs(keys);
    assert.deepEqual(txs.map((t) => t.length), [10, 10, 3]);
    assert.ok(new PublicKey(ix.programId).equals(program.programId));
  });
});
