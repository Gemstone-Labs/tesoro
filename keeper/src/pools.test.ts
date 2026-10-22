import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, chainOf } from "./fixtures.ts";
import { loadIdl } from "./runtime.ts";
import { poolJob, type PoolDeps } from "./pools.ts";
import { lastUpdateEpoch, poolIsStale, updateStakePoolBalanceIx } from "./stake-pool-update.ts";
import type { Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

/** A 611-byte SPL stake pool account (type 1) with the fields the keeper reads. */
function poolBytes(o: { validatorList: PublicKey; reserve: PublicKey; mint: PublicKey; managerFee: PublicKey; lastUpdateEpoch: bigint }): Info {
  const d = Buffer.alloc(611);
  d[0] = 1;
  o.validatorList.toBuffer().copy(d, 98);
  o.reserve.toBuffer().copy(d, 130);
  o.mint.toBuffer().copy(d, 162);
  o.managerFee.toBuffer().copy(d, 194);
  d.writeBigUInt64LE(1_000_000n, 258);
  d.writeBigUInt64LE(900_000n, 266);
  d.writeBigUInt64LE(o.lastUpdateEpoch, 274);
  return { data: d, executable: false, lamports: 1, owner: STAKE_POOL_PROGRAM };
}

describe("stake pool freshness", () => {
  const fields = { validatorList: k(), reserve: k(), mint: k(), managerFee: k() };
  it("reads the epoch of the last update and judges staleness against the current epoch", () => {
    const pool = poolBytes({ ...fields, lastUpdateEpoch: 7n });
    assert.equal(lastUpdateEpoch(pool), 7n);
    assert.equal(poolIsStale(pool, 7n), false);
    assert.equal(poolIsStale(pool, 8n), true);
    assert.equal(poolIsStale(pool, 8n, 1n), false);
    assert.equal(lastUpdateEpoch(null), null);
  });
  it("builds UpdateStakePoolBalance with the pool's own accounts", () => {
    const address = k();
    const ix = updateStakePoolBalanceIx(address, poolBytes({ ...fields, lastUpdateEpoch: 1n })!);
    assert.equal(ix.programId.toBase58(), STAKE_POOL_PROGRAM.toBase58());
    assert.equal(ix.data[0], 7);
    const keys = ix.keys.map((m) => m.pubkey.toBase58());
    assert.deepEqual([keys[0], keys[2], keys[3], keys[4], keys[5]], [address, fields.validatorList, fields.reserve, fields.managerFee, fields.mint].map((x) => x.toBase58()));
    assert.equal(ix.keys.filter((m) => m.isWritable).length, 4, "pool, validator list, fee account and mint are written");
  });
});

describe("the pool job", () => {
  const payer = Keypair.generate();
  async function run(lastEpoch: bigint, epoch: bigint) {
    const pool = k();
    const custody = await accountBytes(core, "StakeCustody", { pool, mint: k() });
    const info = poolBytes({ validatorList: k(), reserve: k(), mint: k(), managerFee: k(), lastUpdateEpoch: lastEpoch });
    const sent: number[] = [];
    const d: PoolDeps = {
      list: async () => [{ pubkey: k(), data: custody }],
      read: { async many(keys) { return keys.map((x) => (x.equals(pool) ? info : null)); } },
      send: async (ixs) => (sent.push(ixs.length), "sig"),
      epoch: async () => epoch,
    };
    const ctx = { core: chainOf(core, new Map()), conn: { getBalance: async () => 1e9 }, payer, now: 0, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { n: await poolJob(ctx, d), sent };
  }
  it("updates a pool that is behind and leaves a fresh one", async () => {
    assert.deepEqual(await run(5n, 6n), { n: 1, sent: [1] });
    assert.deepEqual(await run(6n, 6n), { n: 0, sent: [] });
  });
});
