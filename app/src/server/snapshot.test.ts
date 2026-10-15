import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { readAccountState, type StateSource } from "@/lib/chain/account-state";
import { POOL, SIM_SOL_MINT, TESORO_CORE_ID, holdingPda, sourcePda } from "@/lib/chain/native";
import { decodeState } from "@/lib/chain/snapshot-wire";
import { getAccountState, serverStateSource, type SnapshotDeps } from "./snapshot";

const coder = new Program(coreIdl as Idl, {} as Provider).coder.accounts;
const key = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const bytes = (k: PublicKey) => Array.from(k.toBytes());
const authority = key(1);
const accountKey = BlockPuzzleChain.coreAccount(authority);
const other = BlockPuzzleChain.coreAccount(key(2));

const info = (data: Buffer, owner = TESORO_CORE_ID): AccountInfo<Buffer> => ({ data, owner, lamports: 1, executable: false });
const encode = async (name: string, value: object) => info(Buffer.from(await coder.encode(name, value)));

/** Debt is derived from the clock: the tests pin it. */
const OPENED_AT = 1_800_000_000;
const at = (secondsAfterOpen: number) => vi.spyOn(Date, "now").mockReturnValue((OPENED_AT + secondsAfterOpen) * 1000);
beforeEach(() => at(0));
afterEach(() => vi.restoreAllMocks());

const position = (owner: PublicKey, over: object = {}) => ({
  bump: 1,
  positionId: Array(32).fill(3),
  inner: {
    owner: bytes(owner),
    sourceChain: { solana: {} },
    sourceAsset: bytes(SIM_SOL_MINT),
    decimals: 9,
    principal: new BN(2_000_000_000),
    rateBps: 500,
    status: { locked: {} },
    advances: 1,
    openAdvance: 0,
    lastSeq: new BN(0),
    cumulativeYield: new BN(0),
    freeYield: new BN(0),
    freeYieldClaimed: new BN(0),
    openedAt: new BN(OPENED_AT),
    appliedNet: new BN(0),
    custodyShares: new BN(2_000_000_000),
    yieldFeeBps: 2000,
    ...over,
  },
});
const source = (pos: PublicKey, owner: PublicKey, issued: number) => ({
  bump: 1,
  inner: {
    position: bytes(pos),
    owner: bytes(owner),
    index: 0,
    horizonMonths: 3,
    unitNum: new BN(1000),
    unitDen: new BN(1000),
    issued: new BN(issued),
    returned: new BN(0),
    redeemed: new BN(0),
    yieldUnits: new BN(0),
    redeemedUnits: new BN(0),
  },
});
const holding = (account: PublicKey, src: PublicKey, isOwn: boolean, amount: number) => ({
  bump: 1,
  account,
  inner: { source: bytes(src), isOwn, amount: new BN(amount), reserved: new BN(0) },
});
const pool = () => {
  const b = Buffer.alloc(100);
  b.writeBigUInt64LE(1_000_000_000n, 72);
  b.writeUInt32LE(700, 88);
  b.writeUInt32LE(4380, 92);
  return info(b);
};

// The Account owns Position `mine` (open Advance, 300 Gemas) and holds won Gemas of `theirs`, a native Position of another Account.
const mine = key(10);
const theirs = key(11);
const mineSource = sourcePda(mine, 0);
const theirSource = sourcePda(theirs, 0);
const holdMine = holdingPda(accountKey, mineSource);
const holdTheirs = holdingPda(accountKey, theirSource);
const holdOther = holdingPda(other, theirSource);

const entries: [PublicKey, AccountInfo<Buffer> | Promise<AccountInfo<Buffer>>][] = [
  [accountKey, encode("tesoroAccount", { bump: 1, authority, evmAddress: Array(20).fill(0), inner: { ownTotal: new BN(300), wonTotal: new BN(40), ownReserved: new BN(0), wonReserved: new BN(0) } })],
  [POOL, pool()],
  [mine, encode("positionState", position(accountKey))],
  [mineSource, encode("sourceState", source(mine, accountKey, 300))],
  [theirs, encode("positionState", position(other, { openAdvance: null }))],
  [theirSource, encode("sourceState", source(theirs, other, 90))],
  [holdMine, encode("holdingState", holding(accountKey, mineSource, true, 300))],
  [holdTheirs, encode("holdingState", holding(accountKey, theirSource, false, 40))],
  [holdOther, encode("holdingState", holding(other, theirSource, false, 50))],
];
const chain = new Map<string, AccountInfo<Buffer>>(await Promise.all(entries.map(async ([k, v]) => [k.toBase58(), await v] as const)));

const lists = {
  HoldingState: [holdMine, holdTheirs, holdOther],
  PositionState: [mine, theirs],
};
const ownerAt = { HoldingState: 9, PositionState: 41 };

function fake() {
  const calls = { infos: [] as number[], lists: 0, owned: 0 };
  const deps: SnapshotDeps = {
    lists: async (q) => {
      calls.lists++;
      const wanted = q.owner!.key;
      const all = q.owner!.offset === ownerAt.HoldingState ? lists.HoldingState : lists.PositionState;
      return all
        .map((k) => ({ pubkey: k.toBase58(), data: chain.get(k.toBase58())!.data }))
        .filter((r) => r.data.subarray(q.owner!.offset, q.owner!.offset + 32).equals(wanted.toBuffer()))
        .map((r) => ({ pubkey: r.pubkey, account: { data: [r.data.toString("base64"), "base64"] as [string, string] } }));
    },
    connection: {
      getMultipleAccountsInfo: (async (keys: PublicKey[]) => {
        calls.infos.push(keys.length);
        return keys.map((k) => chain.get(k.toBase58()) ?? null);
      }) as never,
      getBalance: (async () => 2_500_000_000) as never,
    },
    owned: async (q) => {
      calls.owned++;
      return deps.lists(q);
    },
  };
  return { deps, calls };
}

const browserRead = async () => {
  const { deps } = fake();
  const src: StateSource = { ...serverStateSource(deps) };
  return readAccountState(src, authority, accountKey);
};

describe("Account snapshot on the server", () => {
  it("reads Gemas, Positions and native Debt derived from the clock for the Account", async () => {
    at(0);
    const { deps } = fake();
    const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
    expect(snap.exists).toBe(true);
    expect(snap.lamports).toBe(2_500_000_000);
    expect([snap.ownTotal, snap.wonTotal]).toEqual([300n, 40n]);
    expect(snap.holdings.map((h) => [h.holding.toBase58(), h.amount, h.isOwn, h.native, h.sourceOwner])).toEqual([
      [holdMine.toBase58(), 300n, true, true, accountKey.toBase58()],
      [holdTheirs.toBase58(), 40n, false, true, other.toBase58()],
    ]);
    expect(snap.positions).toHaveLength(1);
    const own = snap.positions[0];
    expect(own.address.equals(mine)).toBe(true);
    expect(own.principal).toBe(2);
    expect(own.advance?.gemasIssued).toBe(300);
    expect(own.native?.openedAt).toBe(OPENED_AT);
    expect(own.native?.yieldFeeBps).toBe(2000);
    expect(own.advance?.debtGemas).toBe(300);
    expect(own.native?.source?.math.issued).toBe(300n);
    expect(snap.market?.pool.speedup).toBe(4380);
  });

  it("shows the Debt repaid and the Gemas redeemable once the clock has run, with nothing cranked", async () => {
    // 2 SOL at 5%, Yield Fee 20%, speedup 4,380: about 11,111 units a second against 300 owed.
    at(60);
    const { deps } = fake();
    const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
    expect(snap.positions[0].advance?.debtGemas).toBe(0);
    const mineHolding = snap.holdings.find((h) => h.holding.equals(holdMine))!;
    expect([mineHolding.sourceDebt, mineHolding.redeemable]).toEqual([0n, 300n]);
  });

  it("equals the browser read of the same accounts", async () => {
    at(0);
    const { deps } = fake();
    const server = decodeState<Awaited<ReturnType<typeof browserRead>>>(JSON.parse(JSON.stringify(await getAccountState(authority, {}, deps))));
    const browser = await browserRead();
    expect({ ...server, fetchedAt: 0 }).toEqual({ ...browser, fetchedAt: 0 });
  });

  it("takes three batched reads at most and one list read per kind", async () => {
    const { deps, calls } = fake();
    await getAccountState(authority, {}, deps);
    expect(calls.lists).toBe(2);
    expect(calls.infos.length).toBeLessThanOrEqual(3);
  });

  it("answers an Account that does not exist yet without lists past the first round", async () => {
    const { deps } = fake();
    chain.delete(accountKey.toBase58());
    try {
      const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
      expect(snap.exists).toBe(false);
      expect(snap.holdings).toEqual([]);
    } finally {
      chain.set(accountKey.toBase58(), await encode("tesoroAccount", { bump: 1, authority, evmAddress: Array(20).fill(0), inner: { ownTotal: new BN(300), wonTotal: new BN(40), ownReserved: new BN(0), wonReserved: new BN(0) } }));
    }
  });

  it("reads the Account's own rows upstream and merges them over the cached lists after its own transaction", async () => {
    const { deps, calls } = fake();
    const cached = deps.lists;
    // The cached lists lack the Account's Holding of its own Position (created since the list was cached).
    deps.lists = async (q) => (await cached(q)).filter((r) => r.pubkey !== holdMine.toBase58());
    const stale = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
    expect(calls.owned).toBe(0);
    expect(stale.holdings.map((h) => h.holding.toBase58())).toEqual([holdTheirs.toBase58()]);
    deps.owned = async (q) => {
      calls.owned++;
      return (await cached(q)).filter((r) => r.pubkey === holdMine.toBase58() || r.pubkey === mine.toBase58());
    };
    const fresh = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, { fresh: true }, deps));
    expect(calls.owned).toBe(2);
    expect(fresh.holdings.map((h) => h.holding.toBase58()).sort()).toEqual([holdMine.toBase58(), holdTheirs.toBase58()].sort());
  });

  it("answers from the cached lists when the owner read fails", async () => {
    const { deps } = fake();
    deps.owned = async () => {
      throw new Error("429");
    };
    const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, { fresh: true }, deps));
    expect(snap.holdings).toHaveLength(2);
  });
});
