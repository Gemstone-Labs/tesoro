import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { readAccountState, type StateSource } from "@/lib/chain/account-state";
import { POOL, SIM_SOL_MINT, TESORO_CORE_ID, sourcePda } from "@/lib/chain/native";
import { basketPda, bookPda, spillPda, SIDE_OWN, SIDE_WON } from "@/lib/chain/basket";
import { encodeBook, encodeStore, freshClass, lineOf } from "@/lib/chain/basket-fixture";
import { fp } from "@/lib/chain/book";
import { decodeState } from "@/lib/chain/snapshot-wire";
import { OVERFLOW_DISC, OVERFLOW_STORE_AT } from "@/lib/chain/overflow";
import bs58 from "bs58";
import stakeFixtures from "@/lib/chain/position-stake.fixtures.json";
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
const DUE = 1_800_000_600n;
/** The Account's own 300 Gemas of `mine` sit in the basket, its 40 won Gemas of `theirs` in the spill; nothing is landed yet, so both lines are all unpaid. */
const basket = encodeStore([lineOf({ source: mineSource, side: SIDE_OWN, dueAt: DUE, amount: 300n, uncovered: fp(300n) })], { account: accountKey, capacity: 4 });
const spill = encodeStore([lineOf({ source: theirSource, side: SIDE_WON, dueAt: DUE, amount: 40n, uncovered: fp(40n) })], { account: accountKey, capacity: 1 });
const book = (owed: bigint) => encodeBook([freshClass(), freshClass(), freshClass(), { ...freshClass(), uncovered: fp(owed), w: fp(owed) }]);

const entries: [PublicKey, AccountInfo<Buffer> | Promise<AccountInfo<Buffer>>][] = [
  [accountKey, encode("tesoroAccount", { bump: 1, authority, evmAddress: Array(20).fill(0) })],
  [basketPda(accountKey), info(basket)],
  [spillPda(accountKey), info(spill)],
  [POOL, pool()],
  [mine, encode("positionState", position(accountKey))],
  [mineSource, encode("sourceState", source(mine, accountKey, 300))],
  [bookPda(mineSource), info(book(300n))],
  [theirs, encode("positionState", position(other, { openAdvance: null }))],
  [theirSource, encode("sourceState", source(theirs, other, 90))],
  [bookPda(theirSource), info(book(90n))],
];
const chain = new Map<string, AccountInfo<Buffer>>(await Promise.all(entries.map(async ([k, v]) => [k.toBase58(), await v] as const)));

const lists = { PositionState: [mine, theirs] };

function fake() {
  const calls = { infos: [] as number[], lists: 0, owned: 0 };
  const deps: SnapshotDeps = {
    lists: async (q) => {
      calls.lists++;
      const wanted = q.owner!.key;
      return lists.PositionState
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
    expect(snap.holdings.map((h) => [h.source.toBase58(), h.amount, h.isOwn, h.native, h.sourceOwner, h.store])).toEqual([
      [mineSource.toBase58(), 300n, true, true, accountKey.toBase58(), "basket"],
      [theirSource.toBase58(), 40n, false, true, other.toBase58(), "spill"],
    ]);
    expect(snap.holdings.map((h) => h.redeemable)).toEqual([0n, 0n]);
    expect(snap.holdings[0].line).toEqual({ side: 0, dueAt: DUE, class: 3, tranche: 0 });
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
    const mineHolding = snap.holdings.find((h) => h.source.equals(mineSource))!;
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
    expect(calls.lists).toBe(2); // the Positions and the overflow records
    expect(calls.infos.length).toBeLessThanOrEqual(3);
  });

  it("shows the Gemas waiting for room in the Account's overflow records, and nothing when there are none", async () => {
    const { deps } = fake();
    expect((decodeState<{ waiting?: unknown }>(JSON.parse(JSON.stringify(await getAccountState(authority, {}, deps))))).waiting).toBeUndefined();
    const store = encodeStore([lineOf({ side: 1, source: mineSource, amount: 70n })], { account: accountKey, capacity: 2 });
    const raw = Buffer.alloc(OVERFLOW_STORE_AT + store.length - 8);
    OVERFLOW_DISC.forEach((b, i) => (raw[i] = b));
    store.copy(raw, OVERFLOW_STORE_AT, 8);
    const recordKey = new PublicKey(new Uint8Array(32).fill(21));
    const withRecord: SnapshotDeps = {
      ...deps,
      lists: async (q) => (q.disc === bs58.encode(OVERFLOW_DISC) ? [{ pubkey: recordKey.toBase58(), account: { data: [raw.toString("base64"), "base64"] as [string, string] } }] : deps.lists(q)),
    };
    const state = decodeState<{ waiting?: { address: PublicKey; gemas: bigint }[] }>(JSON.parse(JSON.stringify(await getAccountState(authority, {}, withRecord))));
    expect(state.waiting?.map((w) => [w.address.toBase58(), w.gemas])).toEqual([[recordKey.toBase58(), 70n]]);
  });

  it("answers an Account that does not exist yet without lists past the first round", async () => {
    const { deps } = fake();
    chain.delete(accountKey.toBase58());
    try {
      const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
      expect(snap.exists).toBe(false);
      expect(snap.holdings).toEqual([]);
    } finally {
      chain.set(accountKey.toBase58(), await encode("tesoroAccount", { bump: 1, authority, evmAddress: Array(20).fill(0) }));
    }
  });

  it("reads the Account's own Positions upstream and merges them over the cached list after its own transaction", async () => {
    const { deps, calls } = fake();
    const cached = deps.lists;
    // The cached list lacks the Account's own Position (opened since the list was cached).
    deps.lists = async (q) => (await cached(q)).filter((r) => r.pubkey !== mine.toBase58());
    const stale = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
    expect(calls.owned).toBe(0);
    expect(stale.positions).toHaveLength(0);
    deps.owned = async (q) => {
      calls.owned++;
      return (await cached(q)).filter((r) => r.pubkey === mine.toBase58());
    };
    const fresh = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, { fresh: true }, deps));
    expect(calls.owned).toBe(1);
    expect(fresh.positions.map((p) => p.address.toBase58())).toEqual([mine.toBase58()]);
  });

  it("answers from the cached list when the owner read fails", async () => {
    const { deps } = fake();
    deps.owned = async () => {
      throw new Error("429");
    };
    const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, { fresh: true }, deps));
    expect(snap.positions).toHaveLength(1);
    expect(snap.holdings).toHaveLength(2);
  });
});

describe("Account snapshot with Positions of both layouts (ticket 55)", () => {
  // Stake Locks written by tesoro_core (235 bytes before migrate_position, 243 after), made the Account's own.
  const images = Object.entries(stakeFixtures)
    .filter(([k]) => k !== "_note")
    .map(([name, f]: [string, any], i) => {
      const data = Buffer.from(f.data, "hex");
      accountKey.toBuffer().copy(data, 41); // owner: after the discriminator, bump and position id
      return { name, key: key(40 + i), data, expect: f.expect };
    });
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [accountKey.toBase58(), chain.get(accountKey.toBase58())!],
    [basketPda(accountKey).toBase58(), info(encodeStore([], { account: accountKey, capacity: 4 }))],
    [spillPda(accountKey).toBase58(), info(encodeStore([], { account: accountKey, capacity: 1 }))],
    ...images.map((im) => [im.key.toBase58(), info(im.data)] as [string, AccountInfo<Buffer>]),
  ]);
  const rows = images.map((im) => ({ pubkey: im.key.toBase58(), account: { data: [im.data.toString("base64"), "base64"] as [string, string] } }));
  const deps: SnapshotDeps = {
    lists: async () => rows,
    owned: async () => rows,
    connection: {
      getMultipleAccountsInfo: (async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null)) as never,
      getBalance: (async () => 0) as never,
    },
  };

  it("lists and decodes every Position, 235 and 243 bytes alike, with the fields the program wrote", async () => {
    const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, { fresh: true }, deps));
    expect(snap.positions.map((p) => p.address.toBase58())).toEqual(images.map((im) => im.key.toBase58()));
    for (const [i, p] of snap.positions.entries()) {
      const want = images[i].expect;
      expect([p.principal, p.advances, p.status, p.native?.openAdvance, p.native?.appliedNet, p.native?.stakeRateOpen, p.native?.stakeRateHigh], images[i].name).toEqual([
        Number(want.principal) / 1e9,
        want.advances,
        "locked",
        want.openAdvance,
        BigInt(want.appliedNet),
        BigInt(want.stakeRateOpen),
        BigInt(want.stakeRateHigh ?? 0),
      ]);
    }
  });
});

describe("Account snapshot right after an Unlock, while the cached list still shows the Position as Locked", () => {
  const unlocked = position(accountKey, { status: { unlocked: {} }, openAdvance: null });
  const staleList = (data: Buffer) => ({ pubkey: mine.toBase58(), account: { data: [data.toString("base64"), "base64"] as [string, string] } });

  it("reads the Position as the chain has it: Unlocked, no open Advance, its Gemas still native", async () => {
    at(60);
    const { deps } = fake();
    const lockedRow = staleList(chain.get(mine.toBase58())!.data);
    const unlockedInfo = await encode("positionState", unlocked);
    deps.lists = async (q) => (q.owner!.key.equals(accountKey) ? [lockedRow] : []);
    const getInfos = deps.connection.getMultipleAccountsInfo;
    deps.connection = {
      ...deps.connection,
      getMultipleAccountsInfo: (async (keys: PublicKey[], c: unknown) => (await (getInfos as any)(keys, c)).map((r: AccountInfo<Buffer> | null, i: number) => (keys[i].equals(mine) ? unlockedInfo : r))) as never,
    };
    const snap = decodeState<Awaited<ReturnType<typeof browserRead>>>(await getAccountState(authority, {}, deps));
    expect(snap.positions.map((p) => [p.status, p.advance, p.native?.status])).toEqual([["unlocked", null, "unlocked"]]);
    expect(snap.holdings.map((h) => h.native)).toEqual([true, true]);
  });
});
