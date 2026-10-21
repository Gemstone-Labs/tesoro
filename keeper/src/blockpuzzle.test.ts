import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain } from "../../app/src/games/block-puzzle/chain.ts";
import { Budget, type Ctx } from "./act.ts";
import { blockPuzzle } from "./blockpuzzle.ts";


/**
 * A joined Match past both deadlines whose Boards are both in the rollup. `perms` says which permissions exist in the
 * rollup (seat 0, seat 1, SeedVault). Records the rollup and base calls the keeper makes.
 */
function stubCtx(id: bigint, perms: [boolean, boolean, boolean], failPermission = false) {
  const a = BlockPuzzleChain.addresses(id);
  const calls: string[] = [];
  const exists = new Map([a.boards[0], a.boards[1], a.vault].map((t, i) => [permissionPdaFromAccount(t).toBase58(), perms[i]]));
  const tee = {
    getMultipleAccountsInfo: async (keys: any[]) => keys.map((k) => (exists.get(k.toBase58()) ? { owner: PERMISSION_PROGRAM_ID } : null)),
  };
  const info = (owner: any) => ({ owner, data: Buffer.alloc(0), lamports: 1, executable: false });
  const ctx = {
    now: 10_000,
    settings: { dryRun: false },
    budget: new Budget(1e9),
    payer: Keypair.generate(),
    conn: {
      getBalance: async () => 1e9,
      getMultipleAccountsInfo: async () => [info(BLOCK_PUZZLE_PROGRAM_ID), info(DELEGATION_PROGRAM_ID), info(DELEGATION_PROGRAM_ID)],
    },
    bp: {
      bp: { coder: { accounts: { decode: () => ({ settled: false, joined: true, openerDeadline: 100, deadline: 200 }) } } },
      tee: async () => tee,
      initPermission: async (_s: unknown, _id: bigint, seat: number) => {
        calls.push(`initPermission ${seat}`);
        if (failPermission) throw new Error("tee busy");
        return "p";
      },
      initVaultPermission: async () => (calls.push("initVaultPermission"), "v"),
      sealAndCommit: async () => (calls.push("sealAndCommit"), { teeSig: "s" }),
      settle: async () => (calls.push("settle"), { sig: "x" }),
    },
  } as unknown as Ctx;
  return { ctx, calls };
}

describe("Block Burst permissions (OC-11)", () => {
  it("creates a permission missing after an earlier delegate, before seal + commit_boards", async () => {
    // The old keeper delegated and created the permission in one step: once the Board was delegated it never
    // retried, and sealAndCommit (commit_boards closes all three permissions) kept failing.
    const { ctx, calls } = stubCtx(42n, [true, false, false]);
    await blockPuzzle(ctx, 42n, { deadline: 0 }, "active", "match=42");
    assert.deepEqual(calls, ["initPermission 1", "initVaultPermission", "sealAndCommit", "settle"]);
  });

  it("does not seal while a permission is still missing, and retries it next time", async () => {
    const { ctx, calls } = stubCtx(43n, [true, false, true], true);
    await blockPuzzle(ctx, 43n, { deadline: 0 }, "active", "match=43");
    assert.deepEqual(calls, ["initPermission 1"]);
  });

  it("goes straight to seal when every permission exists", async () => {
    const { ctx, calls } = stubCtx(44n, [true, true, true]);
    await blockPuzzle(ctx, 44n, { deadline: 0 }, "active", "match=44");
    assert.deepEqual(calls, ["sealAndCommit", "settle"]);
  });
});
