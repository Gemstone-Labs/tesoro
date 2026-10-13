import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { readAccountState, type StateSource } from "@/lib/chain/account-state";
import { POOL, SIM_SOL_MINT, TESORO_CORE_ID, custodyPda, holdingPda, sourcePda, vaultPda } from "@/lib/chain/native";
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
/** NativeCustody: tracked_shares sits after disc, two bumps, five keys and three u64s. */
const custody = (tracked: bigint) => {
  const b = Buffer.alloc(8 + 2 + 5 * 32 + 40);
  b.writeBigUInt64LE(tracked, 8 + 2 + 5 * 32 + 24);
  return info(b);
};
const vault = (shares: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(shares, 64);
  return info(b);
};
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
  [custodyPda(mine), custody(2_000_000_000n)],
  [vaultPda(mine), vault(2_000_000_000n)],
  [mineSource, encode("sourceState", source(mine, accountKey, 300))],
  [theirs, encode("positionState", position(other, { openAdvance: null }))],
  [custodyPda(theirs), custody(1_000_000_000n)],
  [vaultPda(theirs), vault(1_000_000_000n)],
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
  const calls = { infos: [] as number[], lists: 0 };
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
    invalidate: () => undefined,
  };
  return { deps, calls };
}

const browserRead = async () => {
  const { deps } = fake();
  const src: StateSource = { ...serverStateSource(deps) };
  return readAccountState(src, authority, accountKey);
};

describe("Account snapshot on the server", () => {
  it("reads Gemas, Positions and native custody for the Account", async () => {
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
    expect(own.native?.vaultShares).toBe(2_000_000_000n);
    expect(own.native?.source?.math.issued).toBe(300n);
    expect(snap.market?.pool.speedup).toBe(4380);
  });

  it("equals the browser read of the same accounts", async () => {
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

  it("invalidates the lists first when the Account just sent a transaction", async () => {
    const { deps } = fake();
    let invalidated = 0;
    deps.invalidate = () => void invalidated++;
    await getAccountState(authority, {}, deps);
    expect(invalidated).toBe(0);
    await getAccountState(authority, { fresh: true }, deps);
    expect(invalidated).toBe(1);
  });
});
