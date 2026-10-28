import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DEVNET_GENESIS,
  MAINNET_GENESIS,
  MIGRATE_CU_LIMIT,
  MIGRATE_FEE_LAMPORTS,
  MIGRATE_POSITION_CU,
  MIGRATIONS_PER_TX,
  UPGRADE_PATTERN,
  classify,
  excessClaims,
  gates,
  healthError,
  isStake,
  keeperStateError,
  migrateIx,
  migrateTx,
  migrateTxs,
  requiredLamports,
  soDeployed,
  upgradeAuthorityOf,
  upgradesFrom,
  type Preflight,
} from "./migrate-positions.ts";
import { coreProgram } from "./retire-old.ts";

const fixtures = JSON.parse(readFileSync(new URL("../../app/src/lib/chain/position-size.fixtures.json", import.meta.url), "utf8"));
const devnet = (k: "some" | "noneStale") => Buffer.from(fixtures[k].data, "base64");
/** Stake Positions as tesoro_core writes them (LiteSVM, programs/tesoro_core/tests/stake_audit/fixtures.rs). */
const stakeFixtures = JSON.parse(readFileSync(new URL("../../app/src/lib/chain/position-stake.fixtures.json", import.meta.url), "utf8"));
const written = (k: "stake243Some" | "stake243NoneStale" | "stake235Some" | "stake235NoneStale") => Buffer.from(stakeFixtures[k].data, "hex");

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
    const rows = [row(devnet("some")), row(devnet("noneStale")), row(written("stake235Some")), row(written("stake235NoneStale")), row(written("stake243Some")), row(written("stake243NoneStale"))];
    const c = classify(rows);
    assert.equal(c.legacy.length, 4);
    assert.equal(c.legacyStake.length, 2);
    assert.equal(c.current, 2);
    assert.deepEqual(rows.map(isStake), [false, false, true, true, true, true]);
  });

  it("finds legacy stake Locks whose holders are owed more than their custody holds (design-v4 5a)", () => {
    const over = row(stake(235, { custody: 10_000_000_000n, paid: 1n, heldWhole: 10_348_956_599n }));
    const fine = row(stake(235, { custody: 10_000_000_000n, paid: 0n, heldWhole: 9_000_000_000n }));
    const found = excessClaims([over, fine, row(written("stake235Some")), row(written("stake235NoneStale"))]);
    assert.deepEqual(found.map((e) => [e.position.toBase58(), e.excess]), [[over.pubkey.toBase58(), 348_956_600n]]);
  });

  it("needs the buffer and extend rent, write-buffer's fees and the rent of 8 bytes (and a fee share) per Position", () => {
    // Devnet and mainnet rents read 2026-10-28: 1,884,680 - 1,844,040 = 40,640 lamports for 8 bytes; a 3,150,120-byte .so.
    const n = { positions: 83, bufferLamports: 16_003_427_200n, extendLamports: 109_745_280n, soBytes: 3_150_120, migrationRent: 40_640n };
    const writeFees = BigInt(Math.ceil(3_150_120 / 900)) * 5_000n;
    assert.equal(requiredLamports(n), 16_003_427_200n + 109_745_280n + writeFees + 83n * (40_640n + MIGRATE_FEE_LAMPORTS));
    assert.ok(requiredLamports({ ...n, extendLamports: 0n }) < requiredLamports(n), "the extend's rent counts");
  });

  const deployer = Keypair.generate().publicKey;
  const ok: Preflight = {
    upgrades: [],
    genesis: { read: DEVNET_GENESIS, send: DEVNET_GENESIS, mainnet: MAINNET_GENESIS },
    deployer,
    upgradeAuthority: deployer,
    admin: deployer,
    deployerLamports: 10n,
    required: 10n,
    mainnetStake: 0,
  };

  it("refuses to start on a wrong cluster, another upgrade, a foreign authority, a short deployer or mainnet stake Positions", () => {
    assert.deepEqual(gates(ok), []);
    assert.match(gates({ ...ok, genesis: { ...ok.genesis, read: MAINNET_GENESIS } }).join(), /--read-rpc is not devnet/);
    assert.match(gates({ ...ok, genesis: { ...ok.genesis, send: "x" } }).join(), /--rpc is not devnet/);
    assert.match(gates({ ...ok, genesis: { ...ok.genesis, mainnet: DEVNET_GENESIS } }).join(), /--mainnet-rpc is not mainnet/);
    assert.match(gates({ ...ok, upgrades: ["vps: 123 solana program deploy x"] }).join(), /another program upgrade/);
    assert.match(gates({ ...ok, upgradeAuthority: Keypair.generate().publicKey }).join(), /upgrade authority/);
    assert.match(gates({ ...ok, upgradeAuthority: null }).join(), /upgrade authority is none/);
    assert.match(gates({ ...ok, admin: Keypair.generate().publicKey }).join(), /Config admin/);
    assert.match(gates({ ...ok, deployerLamports: 9n }).join(), /deployer holds/);
    assert.match(gates({ ...ok, mainnetStake: 2 }).join(), /mainnet has 2 stake Positions/);
  });

  it("treats a failed upgrade check as a refusal, and finds upgrades of either tool", () => {
    assert.deepEqual(upgradesFrom("vps", 1, ""), []);
    assert.deepEqual(upgradesFrom("vps", 0, "42 solana program write-buffer x.so\n"), ["vps: 42 solana program write-buffer x.so"]);
    assert.match(upgradesFrom("vps", 2, "", "pgrep: invalid option -- 'A'").join(), /vps: could not check .*exit 2: pgrep: invalid option/);
    assert.match(upgradesFrom("vps", 255, "", "ssh: connect to host vps: Connection refused").join(), /could not check/);
    assert.match(upgradesFrom("this machine", null, "", "spawnSync pgrep ENOENT").join(), /exit none/);
    const re = new RegExp(UPGRADE_PATTERN);
    for (const cmd of ["solana program deploy --buffer B", "solana program write-buffer t.so", "solana program extend P 10240", "solana program upgrade B P", "anchor deploy", "anchor upgrade t.so --program-id P"]) assert.ok(re.test(cmd), cmd);
    for (const cmd of ["solana balance", "solana program show P", "anchor build", "cargo test"]) assert.ok(!re.test(cmd), cmd);
  });

  it("reads the upgrade authority and whether ProgramData already holds the .so (a re-run skips the upgrade)", () => {
    const so = Buffer.from([1, 2, 3, 4, 5]);
    const pd = Buffer.alloc(45 + 8);
    pd.writeUInt32LE(3, 0);
    pd[12] = 1;
    deployer.toBuffer().copy(pd, 13);
    so.copy(pd, 45);
    assert.ok(upgradeAuthorityOf(pd)!.equals(deployer));
    assert.equal(upgradeAuthorityOf(Buffer.alloc(53)), null);
    assert.equal(soDeployed(pd, so), true);
    assert.equal(soDeployed(pd, Buffer.from([1, 2, 3, 4, 6])), false);
    const tail = Buffer.from(pd);
    tail[52] = 9; // bytes left over from a larger old program
    assert.equal(soDeployed(tail, so), false);
    assert.equal(soDeployed(pd.subarray(0, 48), so), false);
  });

  it("requires the keeper to be inactive before the upgrade and alive with a finished pass after", () => {
    assert.equal(keeperStateError("inactive", "inactive\n"), null);
    assert.match(keeperStateError("inactive", "deactivating")!, /"deactivating", not "inactive"/);
    assert.match(keeperStateError("active", "")!, /no answer/);
    assert.equal(healthError(JSON.stringify({ alive: true, passes: 1, failedInARow: 0 })), null);
    assert.match(healthError(JSON.stringify({ alive: true, passes: 0 }))!, /no finished pass/);
    assert.match(healthError(JSON.stringify({ alive: false, passes: 9 }))!, /not alive/);
    assert.match(healthError("<html>502</html>")!, /not JSON/);
  });

  it("builds one admin-signed migrate_position per Position, a full batch per transaction", async () => {
    const program = coreProgram();
    const admin = Keypair.generate().publicKey;
    const keys = Array.from({ length: 2 * MIGRATIONS_PER_TX + 3 }, () => Keypair.generate().publicKey);
    const ix = await migrateIx(program, admin, keys[0]);
    const name = (program.idl as any).instructions.find((i: any) => Buffer.from(i.discriminator).equals(ix.data.subarray(0, 8))).name;
    assert.equal(name, "migratePosition");
    assert.ok(ix.keys[0].pubkey.equals(admin) && ix.keys[0].isSigner && ix.keys[0].isWritable);
    assert.ok(ix.keys[2].pubkey.equals(keys[0]) && ix.keys[2].isWritable);
    assert.deepEqual(migrateTxs(keys).map((t) => t.length), [MIGRATIONS_PER_TX, MIGRATIONS_PER_TX, 3]);
    assert.ok(new PublicKey(ix.programId).equals(program.programId));
  });

  it("sizes the batch to the transaction limit and its compute from the LiteSVM measurement", async () => {
    const program = coreProgram();
    const admin = Keypair.generate();
    const signed = async (n: number) => {
      const ixs = await Promise.all(Array.from({ length: n }, () => migrateIx(program, admin.publicKey, Keypair.generate().publicKey)));
      const tx = migrateTx(ixs);
      tx.feePayer = admin.publicKey;
      tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
      tx.sign(admin);
      return tx;
    };
    // The full batch serialises within 1,232 bytes; one more Position does not fit.
    assert.ok((await signed(MIGRATIONS_PER_TX)).serialize().length <= 1_232);
    await assert.rejects(async () => (await signed(MIGRATIONS_PER_TX + 1)).serialize(), /Transaction too large/);
    // Each Position gets a third more compute than measured; the whole batch stays far under the 1.4M transaction limit.
    assert.ok(MIGRATE_CU_LIMIT >= Math.ceil(MIGRATE_POSITION_CU * 1.3));
    assert.ok(MIGRATE_CU_LIMIT * MIGRATIONS_PER_TX <= 1_400_000);
  });
});
