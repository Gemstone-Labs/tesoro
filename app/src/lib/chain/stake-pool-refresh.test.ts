import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { STAKE_POOL_PROGRAM_ID, parseStakePool, updateStakePoolBalanceIx } from "./stake-pool";
import { VALIDATOR_ENTRY_LEN, VALIDATOR_LIST_ENTRIES_AT, stakePoolRefreshIxs } from "./stake-pool-refresh";

const JITO_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const live = readFileSync(join(__dirname, "../../../../programs/tesoro_core/tests/fixtures/jito_pool.bin"));
const listKey = new PublicKey(live.subarray(98, 130));

const poolAt = (lastUpdateEpoch: bigint) => {
  const d = Buffer.from(live);
  d.writeBigUInt64LE(lastUpdateEpoch, 274);
  return d;
};

/** A validator list holding `epochs.length` entries, each last updated in the given epoch. */
const validatorList = (epochs: bigint[]) => {
  const d = Buffer.alloc(VALIDATOR_LIST_ENTRIES_AT + epochs.length * VALIDATOR_ENTRY_LEN);
  d[0] = 2;
  d.writeUInt32LE(epochs.length + 10, 1);
  d.writeUInt32LE(epochs.length, 5);
  epochs.forEach((e, i) => d.writeBigUInt64LE(e, VALIDATOR_LIST_ENTRIES_AT + i * VALIDATOR_ENTRY_LEN + 16));
  return d;
};

function chain(opts: { pool: Buffer; epoch: number; list: Buffer }) {
  const reads: { key: string; offset?: number; length?: number }[] = [];
  return {
    reads,
    getEpochInfo: async () => ({ epoch: opts.epoch }),
    getAccountInfo: async (key: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) => {
      reads.push({ key: key.toBase58(), ...cfg?.dataSlice });
      const whole = key.equals(JITO_POOL) ? opts.pool : key.equals(listKey) ? opts.list : null;
      if (!whole) return null;
      const s = cfg?.dataSlice;
      return { data: s ? whole.subarray(s.offset, s.offset + s.length) : whole, owner: STAKE_POOL_PROGRAM_ID };
    },
  };
}

describe("UpdateStakePoolBalance in a Player's transaction", () => {
  it("builds the instruction from the pool's own accounts", () => {
    const ix = updateStakePoolBalanceIx(JITO_POOL, { data: live, owner: STAKE_POOL_PROGRAM_ID });
    const view = parseStakePool(live)!;
    expect(ix.programId.equals(STAKE_POOL_PROGRAM_ID)).toBe(true);
    expect(ix.data[0]).toBe(7);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [JITO_POOL, undefined, listKey, view.reserveStake, view.managerFeeAccount, view.poolMint, undefined].map((k, i) => (k ? k.toBase58() : ix.keys[i].pubkey.toBase58())),
    );
  });

  it("adds nothing while the pool is current or one epoch behind", async () => {
    for (const last of [1075n, 1074n]) {
      const c = chain({ pool: poolAt(last), epoch: 1075, list: validatorList([1075n]) });
      expect(await stakePoolRefreshIxs(c, JITO_POOL)).toEqual([]);
    }
  });

  it("adds the update when the pool is more than one epoch behind and the validator list is current", async () => {
    const c = chain({ pool: poolAt(1073n), epoch: 1075, list: validatorList([1075n, 1075n, 1075n]) });
    const ixs = await stakePoolRefreshIxs(c, JITO_POOL);
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(STAKE_POOL_PROGRAM_ID)).toBe(true);
    expect(ixs[0].data[0]).toBe(7);
  });

  it("reads only the list's length and its last entry, not the whole validator list", async () => {
    const c = chain({ pool: poolAt(1000n), epoch: 1075, list: validatorList(new Array(500).fill(1075n)) });
    await stakePoolRefreshIxs(c, JITO_POOL);
    const listReads = c.reads.filter((r) => r.key === listKey.toBase58());
    expect(listReads.length).toBeGreaterThan(0);
    for (const r of listReads) expect(r.length).toBeLessThanOrEqual(VALIDATOR_ENTRY_LEN);
  });

  it("adds nothing when the validator list itself is behind: the update would fail, so the existing error shows", async () => {
    const c = chain({ pool: poolAt(1000n), epoch: 1075, list: validatorList([1075n, 1075n, 1074n]) });
    expect(await stakePoolRefreshIxs(c, JITO_POOL)).toEqual([]);
  });

  it("adds nothing when the pool account cannot be read", async () => {
    const c = chain({ pool: poolAt(1000n), epoch: 1075, list: validatorList([1075n]) });
    expect(await stakePoolRefreshIxs(c, Keypair.generate().publicKey)).toEqual([]);
  });
});
