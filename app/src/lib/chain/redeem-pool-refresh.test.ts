import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIM_SOL_MINT } from "./native";
import { JITOSOL } from "./stake";
import { STAKE_POOL_PROGRAM_ID } from "./stake-pool";
import { VALIDATOR_ENTRY_LEN, VALIDATOR_LIST_ENTRIES_AT } from "./stake-pool-refresh";

const live = readFileSync(join(__dirname, "../../../../programs/tesoro_core/tests/fixtures/jito_pool.bin"));
const listKey = new PublicKey(live.subarray(98, 130));
const state = vi.hoisted(() => ({ lastUpdate: 0n, epoch: 0 }));

vi.mock("./client", () => ({
  getChain: () => ({
    base: {
      getEpochInfo: async () => ({ epoch: state.epoch }),
      getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => ({ data: Buffer.alloc(165) })),
      getAccountInfo: async (key: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) => {
        let whole: Buffer;
        if (key.equals(JITOSOL.pool)) {
          whole = Buffer.from(live);
          whole.writeBigUInt64LE(state.lastUpdate, 274);
        } else if (key.equals(listKey)) {
          whole = Buffer.alloc(VALIDATOR_LIST_ENTRIES_AT + VALIDATOR_ENTRY_LEN);
          whole.writeUInt32LE(1, 5);
          whole.writeBigUInt64LE(BigInt(state.epoch), VALIDATOR_LIST_ENTRIES_AT + 16);
        } else return null;
        const s = cfg?.dataSlice;
        return { data: s ? whole.subarray(s.offset, s.offset + s.length) : whole, owner: STAKE_POOL_PROGRAM_ID };
      },
    },
  }),
}));

const position = Keypair.generate().publicKey;
const me = Keypair.generate().publicKey;

describe("Unlock of a staking-token Position", () => {
  beforeEach(() => {
    state.epoch = 1075;
  });

  it("starts with the pool update when the pool is more than one epoch behind", async () => {
    state.lastUpdate = 1072n;
    const { unlockIxs } = await import("./redeem");
    const ixs = await unlockIxs(me, { position, openAdvance: null, stakeRateOpen: 1n, mint: JITOSOL.mint });
    expect(ixs[0].programId.equals(STAKE_POOL_PROGRAM_ID)).toBe(true);
    expect(ixs).toHaveLength(2);
  });

  it("is the unlock alone while the pool is current", async () => {
    state.lastUpdate = 1075n;
    const { unlockIxs } = await import("./redeem");
    const ixs = await unlockIxs(me, { position, openAdvance: null, stakeRateOpen: 1n, mint: JITOSOL.mint });
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(STAKE_POOL_PROGRAM_ID)).toBe(false);
  });

  it("never adds it for a simSOL Position", async () => {
    state.lastUpdate = 1000n;
    const { unlockIxs } = await import("./redeem");
    const ixs = await unlockIxs(me, { position, openAdvance: null, stakeRateOpen: 0n, mint: SIM_SOL_MINT });
    expect(ixs.some((i) => i.programId.equals(STAKE_POOL_PROGRAM_ID))).toBe(false);
  });
});
