import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import { beforeEach, expect, it, vi } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import { basketPda, spillPda } from "./basket";
import { encodeStore, lineOf } from "./basket-fixture";

const state = vi.hoisted(() => ({ stores: new Map<string, Buffer>(), sent: [] as TransactionInstruction[][] }));
vi.mock("./client", () => ({ getChain: () => ({
  base: {
    getAccountInfo: async () => ({ data: Buffer.alloc(61) }),
    getMultipleAccountsInfo: async (keys: { toBase58(): string }[]) => keys.map((k) => {
      const data = state.stores.get(k.toBase58());
      return data ? { data } : null;
    }),
    getBalance: async () => 1_000_000_000,
  },
  sendBase: async (_s: unknown, ixs: TransactionInstruction[]) => { state.sent.push(ixs); return "sig"; },
}) }));

import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { openPositionWithAdvance } from "./native-flow";
const owner = Keypair.generate().publicKey;
const account = BlockPuzzleChain.coreAccount(owner);
const signer = { publicKey: owner } as Parameters<typeof openPositionWithAdvance>[0];
const coder = new BorshInstructionCoder(coreIdl as Idl);
const names = () => state.sent.flat().map((ix) => coder.decode(ix.data)?.name);
beforeEach(() => { state.stores.clear(); state.sent.length = 0; });

it("initializes a retained identity's missing economy stores in the native Lock/Advance transaction", async () => {
  await openPositionWithAdvance(signer, async () => null, 10_000_000n, 12, 1n);
  expect(names()).toEqual(["init_stores", "open_native_position", "take_native_advance"]);
  expect(state.sent).toHaveLength(1);
});

it("makes room before a fifth native Advance when all initial basket slots are occupied", async () => {
  const lines = Array.from({ length: 4 }, () => lineOf({ source: Keypair.generate().publicKey, amount: 28n }));
  state.stores.set(basketPda(account).toBase58(), encodeStore(lines, { account, capacity: 4 }));
  state.stores.set(spillPda(account).toBase58(), encodeStore([], { account, capacity: 0 }));
  await openPositionWithAdvance(signer, async () => null, 10_000_000n, 12, 1n);
  expect(names()).toEqual(["grow_store", "open_native_position", "take_native_advance"]);
  expect(state.sent).toHaveLength(1);
});

it("keeps existing free spill capacity without buying another slot", async () => {
  const lines = Array.from({ length: 4 }, () => lineOf({ source: Keypair.generate().publicKey, amount: 28n }));
  state.stores.set(basketPda(account).toBase58(), encodeStore(lines, { account, capacity: 4 }));
  state.stores.set(spillPda(account).toBase58(), encodeStore([], { account, capacity: 1 }));
  await openPositionWithAdvance(signer, async () => null, 10_000_000n, 12, 1n);
  expect(names()).toEqual(["open_native_position", "take_native_advance"]);
});

it("never spends a spill slot reserved for an admitted Match", async () => {
  const lines = Array.from({ length: 4 }, () => lineOf({ source: Keypair.generate().publicKey, amount: 28n }));
  state.stores.set(basketPda(account).toBase58(), encodeStore(lines, { account, capacity: 4 }));
  state.stores.set(spillPda(account).toBase58(), encodeStore([], { account, capacity: 1, roomReserved: 1 }));
  await openPositionWithAdvance(signer, async () => null, 10_000_000n, 12, 1n);
  expect(names()).toEqual(["grow_store", "open_native_position", "take_native_advance"]);
});
