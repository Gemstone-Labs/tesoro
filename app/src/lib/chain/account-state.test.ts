import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "./idl/tesoro_core.json";
import { prizeUnits, readAccountState, type StateSource } from "./account-state";
import { RATE_SCALE, SIM_SOL_MINT, TESORO_CORE_ID, nativeCustodyPda, redeemPayoutShares, sourcePda } from "./native";
import { basketPda, bookPda, spillPda, SIDE_OWN, SIDE_WON } from "./basket";
import { encodeBook, encodeStore, freshClass, lineOf } from "./basket-fixture";
import { fp } from "./book";
import type { Line } from "./basket";

const coder = new Program(coreIdl as Idl, {} as Provider).coder.accounts;
const key = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 9)));
const bytes = (k: PublicKey) => Array.from(k.toBytes());
const info = (data: Buffer, owner = TESORO_CORE_ID): AccountInfo<Buffer> => ({ data, owner, lamports: 1, executable: false });
const encode = async (name: string, value: object) => info(Buffer.from(await coder.encode(name, value)));

const OPENED_AT = 1_800_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(OPENED_AT * 1000));
afterEach(() => vi.restoreAllMocks());

const authority = key(1);
const accountKey = BlockPuzzleChain.coreAccount(authority);
const other = BlockPuzzleChain.coreAccount(key(2));

const position = (owner: PublicKey, openAdvance: number | null) => ({
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
    openAdvance,
    lastSeq: new BN(0),
    cumulativeYield: new BN(0),
    freeYield: new BN(0),
    freeYieldClaimed: new BN(0),
    openedAt: new BN(OPENED_AT),
    appliedNet: new BN(0),
    custodyShares: new BN(2_000_000_000),
    yieldFeeBps: 2000,
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
const book = (owed: bigint) => encodeBook([freshClass(), freshClass(), freshClass(), { ...freshClass(), uncovered: fp(owed), w: fp(owed) }]);

// Ailton's Account on November 25 (QA report, vault-books.json): 3,600 own Gemas, 6,248 won, of which two Season prize lines of 2,581 and 59.
const mine = key(10);
const theirs = key(11);
const mineSource = sourcePda(mine, 0);
const theirSource = sourcePda(theirs, 0);
const PRIZE_4 = new PublicKey("Cz9HGbm6NATnvKSS7Kr6maMA8dakGKr6z8GEQReBDZzA");
const PRIZE_3 = new PublicKey("FuyXmRFH9yxBYx56JmPHBqT1mbqy3pzcvXstCfb3rgdh");
const D = 1_800_000_600n;
const own = (amount: bigint, dueAt: bigint) => lineOf({ source: mineSource, side: SIDE_OWN, dueAt, amount, uncovered: fp(amount) });
const won = (amount: bigint, dueAt: bigint) => lineOf({ source: theirSource, side: SIDE_WON, dueAt, amount, uncovered: fp(amount) });
// A prize line is won, due at once, General, fully covered (`prize_line_key`).
const prize = (src: PublicKey, amount: bigint) => lineOf({ source: src, side: SIDE_WON, dueAt: 0n, amount });
const LINES: Line[] = [own(2900n, D), own(700n, D + 1n), won(580n, D), won(2588n, D + 1n), won(440n, D + 2n), prize(PRIZE_4, 2581n), prize(PRIZE_3, 59n)];

const prizeSource = (src: PublicKey, season: number, gemas: number, shares: number) => ({
  bump: 1,
  route: nativeCustodyPda(),
  season,
  inner: { source: bytes(src), shares: new BN(shares), gemas: new BN(gemas) },
});

async function chainOf(lines: Line[], extra: [PublicKey, AccountInfo<Buffer>][] = []) {
  const entries: [PublicKey, AccountInfo<Buffer>][] = [
    [accountKey, await encode("tesoroAccount", { bump: 1, authority, evmAddress: Array(20).fill(0) })],
    [basketPda(accountKey), info(encodeStore(lines.slice(0, 5), { account: accountKey, capacity: 5 }))],
    [spillPda(accountKey), info(encodeStore(lines.slice(5), { account: accountKey, capacity: 4 }))],
    [mine, await encode("positionState", position(accountKey, 0))],
    [mineSource, await encode("sourceState", source(mine, accountKey, 3600))],
    [bookPda(mineSource), info(book(3600n))],
    [theirs, await encode("positionState", position(other, null))],
    [theirSource, await encode("sourceState", source(theirs, other, 3608))],
    [bookPda(theirSource), info(book(3608n))],
    [PRIZE_4, await encode("prizeSourceState", prizeSource(PRIZE_4, 4, 10_324, 278_092_716))],
    [PRIZE_3, await encode("prizeSourceState", prizeSource(PRIZE_3, 3, 692, 17_344_318))],
    ...extra,
  ];
  return new Map(entries.map(([k, v]) => [k.toBase58(), v]));
}

function sourceOf(chain: Map<string, AccountInfo<Buffer>>): StateSource {
  return {
    lists: async () => [{ publicKey: mine, account: coder.decode("positionState", chain.get(mine.toBase58())!.data) }],
    infos: async (keys) => keys.map((k) => chain.get(k.toBase58()) ?? null),
    balance: async () => 0,
    decode: (name, data) => coder.decode(name, data),
  };
}

const sum = (xs: { amount: bigint }[]) => xs.reduce((s, h) => s + h.amount, 0n);

describe("Account read: prize Gemas", () => {
  it("counts every line the stores hold: 9,848 Gemas, the two Season prize lines included", async () => {
    const snap = await readAccountState(sourceOf(await chainOf(LINES)), authority, accountKey);
    expect(snap.ownTotal + snap.wonTotal).toBe(9848n);
    expect(snap.holdings).toHaveLength(7);
    expect(sum(snap.holdings)).toBe(9848n);
  });

  it("reads a prize line as ready to Redeem in full, won, with no book and no Debt", async () => {
    const snap = await readAccountState(sourceOf(await chainOf(LINES)), authority, accountKey);
    const prizes = snap.holdings.filter((h) => h.prize);
    expect(prizes.map((h) => [h.source.toBase58(), h.amount])).toEqual([
      [PRIZE_4.toBase58(), 2581n],
      [PRIZE_3.toBase58(), 59n],
    ]);
    for (const h of prizes) {
      expect(h.redeemable).toBe(h.amount);
      expect(h.pending).toBe(0n);
      expect(h.isOwn).toBe(false);
      expect(h.sourceDebt).toBe(0n);
      expect(h.accounts).toEqual([]);
      expect(h.native).toBe(true);
      expect(h.asset).toBe("SOL");
      expect(h.eth).toBeNull();
      expect(h.prize!.route.equals(nativeCustodyPda())).toBe(true);
    }
    expect(prizes.map((h) => h.prize!.season)).toEqual([4, 3]);
  });

  it("values a prize Gema at its Source's escrowed shares: 2,581 of 10,324 Gemas own a quarter of 278,092,716 shares", async () => {
    const snap = await readAccountState(sourceOf(await chainOf(LINES)), authority, accountKey);
    const h = snap.holdings.find((x) => x.source.equals(PRIZE_4))!;
    // base units = gemas × unitNum / unitDen ≈ gemas × shares / prize Gemas (unitDen is floored once)
    const exact = (2581n * 278_092_716n) / 10_324n;
    const got = (h.amount * h.unitNum) / h.unitDen;
    expect(got >= exact - 1n && got <= exact + 1n).toBe(true);
  });

  it("never drops a line it cannot read: it is flagged as unread and still counted", async () => {
    const lost = key(40);
    const lines = [...LINES.slice(0, 6), lineOf({ source: lost, side: SIDE_WON, dueAt: D, amount: 59n, uncovered: fp(59n) })];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snap = await readAccountState(sourceOf(await chainOf(lines)), authority, accountKey);
    expect(sum(snap.holdings)).toBe(9848n - 59n);
    expect(snap.unread?.map((u) => [u.source.toBase58(), u.amount])).toEqual([[lost.toBase58(), 59n]]);
    expect(warn).toHaveBeenCalled();
  });

  it("an Account whose every line reads has no unread list", async () => {
    const snap = await readAccountState(sourceOf(await chainOf(LINES)), authority, accountKey);
    expect(snap.unread).toBeUndefined();
  });
});

describe("a prize Source with no shares left", () => {
  it("is held but neither redeemable nor offered for Redeem: it would pay nothing", async () => {
    const chain = await chainOf(LINES);
    chain.set(PRIZE_3.toBase58(), await encode("prizeSourceState", prizeSource(PRIZE_3, 3, 692, 0)));
    const snap = await readAccountState(sourceOf(chain), authority, accountKey);
    const h = snap.holdings.find((x) => x.source.equals(PRIZE_3))!;
    expect(h.amount).toBe(59n);
    expect(h.redeemable).toBe(0n);
    expect(h.pending).toBe(0n);
    expect(h.native).toBe(false);
    expect(redeemPayoutShares(h, h.amount, RATE_SCALE)).toBe(0n);
  });

  it("pays 0 shares at a zero price instead of dividing by zero", () => {
    expect(redeemPayoutShares({ unitNum: 10n, unitDen: 0n }, 59n, RATE_SCALE)).toBe(0n);
  });
});

describe("prize Gema price", () => {
  it("prices a prize Gema so the Redeem sheet's payout is the escrow shares redeem_prize pays", () => {
    const rate = (RATE_SCALE * 1_183n) / 1_000n; // 1 simSOL = 1.183 SOL
    const u = prizeUnits(10_324n, 278_092_716n, rate);
    const shares = (2581n * 278_092_716n) / 10_324n;
    const paid = redeemPayoutShares(u, 2581n, rate);
    expect(paid >= shares - 2n && paid <= shares + 2n).toBe(true);
  });

  it("without a pool rate, counts one share as one base unit", () => {
    const u = prizeUnits(100n, 1_000n, null);
    expect(redeemPayoutShares(u, 10n, RATE_SCALE)).toBe(100n);
  });
});
