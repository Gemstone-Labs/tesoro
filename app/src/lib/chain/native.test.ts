import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import idl from "./idl/tesoro_core.json";
import sizeFixtures from "./position-size.fixtures.json";
import stakeFixtures from "./position-stake.fixtures.json";
import { decodePosition } from "./position-size";
import { basketPda, bookPda } from "./basket";
import {
  initNativeCustodyIx,
  setTreasuryCompanyIx,
  withdrawTreasuryIx,
  extendNativeAdvanceIx,
  faucetIx,
  openNativePositionIx,
  positionPda,
  debtGemasAt,
  nativeNow,
  nativeInfoFrom,
  poolSpeedup,
  sourceAtClock,
  clockOf,
  nativeCustodyPda,
  nativeVaultPda,
  yieldAuthorityPda,
  yieldConfigPda,
  returnOwnRemaining,
  POOL,
  type NativeInfo,
  quoteExtendAdvance,
  quoteNativeAdvance,
  rateAt,
  setBreakIx,
  setEntryLimitIx,
  setSelfExclusionIx,
  protectionsPda,
  accountPda,
  setExtendLimitIx,
  redeemIx,
  redeemPayoutShares,
  fundTreasuryIx,
  initTreasuryIx,
  redeemTreasuryIx,
  setPriceIx,
  simSolAta,
  SIM_LST_ID,
  SIM_SOL_MINT,
  TOKEN_PROGRAM_ID,
  sourcePda,
  takeNativeAdvanceIx,
  unlockEstimateMs,
  unlockIx,
  type PoolParams,
  treasuryPda,
} from "./native";

const target = { line: { side: 1, dueAt: 5n, class: 3, tranche: 0 }, accounts: [] as PublicKey[] };
const owner = new PublicKey("AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV");
const pool: PoolParams = { baseRate: 1_000_000_000n, baseTs: 0, apyBps: 700, speedup: 4380 };

describe("native instructions", () => {
  it("uses Anchor discriminators sha256('global:<name>')[..8]", () => {
    const d = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8).toString("hex");
    const pos = sourcePda(owner, 0);
    const cases: [Buffer, string][] = [
      [faucetIx(owner).data, "faucet"],
      [setPriceIx(owner, 1n).data, "set_price"],
      [openNativePositionIx(owner, 1, 1n, pos).data, "open_native_position"],
      [takeNativeAdvanceIx(owner, pos, 0, 3, 1400n).data, "take_native_advance"],
      [extendNativeAdvanceIx(owner, pos, 0, 3, 7n, []).data, "extend_native_advance"],
      [setExtendLimitIx(owner, 2).data, "set_extend_limit"],
      [setEntryLimitIx(owner, 500).data, "set_entry_limit"],
      [setBreakIx(owner, 3).data, "set_break"],
      [setSelfExclusionIx(owner, 6).data, "set_self_exclusion"],
      [initNativeCustodyIx(owner).data, "init_native_custody"],
      [setTreasuryCompanyIx(owner, owner).data, "set_treasury_company"],
      [withdrawTreasuryIx(owner, owner, 1n).data, "withdraw_treasury"],
      [redeemIx(owner, pos, pos, 1n, target).data, "redeem"],
      [unlockIx(owner, pos).data, "unlock"],
      [initTreasuryIx(owner, 2000, 3500).data, "init_treasury"],
      [fundTreasuryIx(owner, 1n).data, "fund_treasury"],
      [redeemTreasuryIx(pos, pos, 1n, target).data, "redeem_treasury"],
    ];
    for (const [data, name] of cases) expect(data.subarray(0, 8).toString("hex"), name).toBe(d(name));
  });

  it("marks accounts writable and signer exactly as the IDL says (a read-only account fails with ConstraintMut)", () => {
    const pos = sourcePda(owner, 0);
    const cases: [ReturnType<typeof unlockIx>, string][] = [
      [initNativeCustodyIx(owner), "init_native_custody"],
      [setTreasuryCompanyIx(owner, owner), "set_treasury_company"],
      [withdrawTreasuryIx(owner, owner, 1n), "withdraw_treasury"],
      [redeemIx(owner, pos, pos, 1n, target), "redeem"],
      [unlockIx(owner, pos), "unlock"],
      [openNativePositionIx(owner, 1, 1n, pos), "open_native_position"],
      [takeNativeAdvanceIx(owner, pos, 1, 3, 1400n, { index: 0, accounts: [bookPda(sourcePda(pos, 0))] }), "take_native_advance"],
      [extendNativeAdvanceIx(owner, pos, 0, 3, 7n, []), "extend_native_advance"],
      [setExtendLimitIx(owner, 2), "set_extend_limit"],
      [setEntryLimitIx(owner, 500), "set_entry_limit"],
      [setBreakIx(owner, 3), "set_break"],
      [setSelfExclusionIx(owner, 6), "set_self_exclusion"],
      [initTreasuryIx(owner, 2000, 3500), "init_treasury"],
      [fundTreasuryIx(owner, 1n), "fund_treasury"],
      [redeemTreasuryIx(pos, pos, 1n, target), "redeem_treasury"],
    ];
    for (const [ix, name] of cases) {
      const spec = (idl.instructions as { name: string; accounts: { writable?: boolean; signer?: boolean }[] }[]).find((i) => i.name === name);
      expect(spec, name).toBeDefined();
      spec!.accounts.forEach((a, i) => {
        if (!ix.keys[i]) return;
        expect(ix.keys[i].isWritable, `${name} account #${i}`).toBe(!!a.writable);
        expect(ix.keys[i].isSigner, `${name} account #${i} signer`).toBe(!!a.signer);
      });
    }
  });

  it("lists exactly the accounts the IDL lists for the Treasury instructions, the treasury where the program expects it", () => {
    const pos = sourcePda(owner, 0);
    const count = (name: string) => (idl.instructions as { name: string; accounts: unknown[] }[]).find((i) => i.name === name)!.accounts.length;
    expect(initNativeCustodyIx(owner).keys).toHaveLength(count("init_native_custody"));
    expect(withdrawTreasuryIx(owner, owner, 1n).keys).toHaveLength(count("withdraw_treasury"));
    expect(setTreasuryCompanyIx(owner, owner).keys).toHaveLength(count("set_treasury_company"));
    expect(openNativePositionIx(owner, 1, 1n, pos).keys).toHaveLength(count("open_native_position"));
    expect(takeNativeAdvanceIx(owner, pos, 0, 3, 1400n).keys).toHaveLength(count("take_native_advance"));
    expect(initTreasuryIx(owner, 2000, 3500).keys).toHaveLength(count("init_treasury"));
    expect(fundTreasuryIx(owner, 1n).keys).toHaveLength(count("fund_treasury"));
    expect(redeemTreasuryIx(pos, pos, 1n, target).keys).toHaveLength(count("redeem_treasury") + 9);
    // The Yield Fee is fixed on the Position at open: only open reads the Treasury, Advance and Extend read the pool.
    expect(openNativePositionIx(owner, 1, 1n, pos).keys[6].pubkey.equals(treasuryPda())).toBe(true);
    expect(takeNativeAdvanceIx(owner, pos, 0, 3, 1400n).keys[5].pubkey.equals(POOL)).toBe(true);
    expect(initTreasuryIx(owner, 2000, 3500).data.subarray(8).toString("hex")).toBe("d007ac0d");
  });

  it("extend_native_advance lists the IDL accounts, carries the months, and derives the Source PDA", () => {
    const pos = sourcePda(owner, 0);
    const ix = extendNativeAdvanceIx(owner, pos, 2, 4, 9n, []);
    const spec = (idl.instructions as { name: string; accounts: unknown[] }[]).find((i) => i.name === "extend_native_advance")!;
    expect(ix.keys).toHaveLength(spec.accounts.length);
    expect(ix.data.subarray(8).toString("hex")).toBe("04" + "0900000000000000");
    expect(ix.keys[2].pubkey.equals(protectionsPda(accountPda(owner)))).toBe(true);
    expect(ix.keys[4].pubkey.equals(POOL)).toBe(true);
    expect(ix.keys[5].pubkey.equals(sourcePda(pos, 2))).toBe(true);
    expect(ix.keys[6].pubkey.equals(basketPda(accountPda(owner)))).toBe(true);
  });

  it("take_native_advance ends with the Gemas floor as a little-endian u64, and an Extend carries its own", () => {
    const pos = sourcePda(owner, 0);
    const take = takeNativeAdvanceIx(owner, pos, 0, 3, 1400n);
    expect(take.data.subarray(8).toString("hex")).toBe("03" + "7805000000000000");
    expect(takeNativeAdvanceIx(owner, pos, 0, 3, (1n << 63n) + 5n).data.readBigUInt64LE(9)).toBe((1n << 63n) + 5n);
  });

  it("passes the previous Advance to take_native_advance, or the program id for none", () => {
    const pos = sourcePda(owner, 0);
    const spec = (idl.instructions as { name: string; accounts: unknown[] }[]).find((i) => i.name === "take_native_advance")!;
    const none = takeNativeAdvanceIx(owner, pos, 1, 3, 1400n);
    expect(none.keys).toHaveLength(spec.accounts.length);
    expect(none.keys[6].pubkey.equals(sourcePda(pos, 1))).toBe(true);
    expect(none.keys[7].pubkey.equals(bookPda(sourcePda(pos, 1)))).toBe(true);
    const prev = takeNativeAdvanceIx(owner, pos, 1, 3, 1400n, { index: 0, accounts: [bookPda(sourcePda(pos, 0))] });
    expect(prev.keys).toHaveLength(spec.accounts.length + 2);
    expect(prev.keys[spec.accounts.length].pubkey.equals(sourcePda(pos, 0))).toBe(true);
    expect(prev.keys[spec.accounts.length].isWritable).toBe(false);
    expect(prev.keys[spec.accounts.length + 1].isWritable).toBe(true);
  });

  it("redeem carries the seven yield accounts, unlock the shared custody, vault and seven more (+ the open Source)", () => {
    const pos = sourcePda(owner, 0);
    const r = redeemIx(owner, pos, pos, 5n, target);
    expect(r.keys).toHaveLength(6 + 2 + 7);
    expect(r.keys.slice(6).map((k) => k.pubkey.toBase58())).toEqual(
      [nativeCustodyPda(), nativeVaultPda(), POOL, simSolAta(owner), SIM_SOL_MINT, yieldConfigPda(), yieldAuthorityPda(), SIM_LST_ID, TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    const withBook = redeemIx(owner, pos, pos, 5n, { ...target, accounts: [bookPda(pos)] });
    expect(withBook.keys.at(-1)!.pubkey.equals(bookPda(pos))).toBe(true);
    expect(withBook.keys.at(-1)!.isWritable).toBe(true);
    const u = unlockIx(owner, pos);
    expect(u.keys).toHaveLength(4 + 2 + 7);
    expect(u.keys[4].pubkey.equals(nativeCustodyPda())).toBe(true);
    expect(u.keys[5].pubkey.equals(nativeVaultPda())).toBe(true);
    const open = unlockIx(owner, pos, { index: 2, accounts: [] });
    expect(open.keys).toHaveLength(4 + 2 + 7 + 1);
    expect(open.keys.at(-1)!.pubkey.equals(sourcePda(pos, 2))).toBe(true);
    expect(open.keys.at(-1)!.isWritable).toBe(true);
    expect(returnOwnRemaining().map((k) => k.pubkey.toBase58())).toEqual([nativeCustodyPda().toBase58(), POOL.toBase58()]);
  });

  it("derives the devnet Position of the deployer (nonce 1)", async () => {
    expect((await positionPda(owner, 1)).toBase58()).toBe("2QxKeDKJfWvGa6uNwXG6533ZpNTazyoUEXj4ALRj2Zb6");
  });
});

describe("native math", () => {
  it("sizes an Advance like the program on the whole yield (5 SOL, 7%, 1 month, $150)", () => {
    const q = quoteNativeAdvance(5_000_000_000n, 700, 1, 150_000_000n);
    expect(q.projectedUnits).toBe(29_166_666n);
    expect(q.gemas).toBe(437n);
  });

  it("keeps the rate constant: yield is per Position, not in the rate", () => {
    expect(rateAt(pool)).toBe(pool.baseRate);
    expect(rateAt(pool)).toBe(pool.baseRate);
  });

  const source = { issued: 437n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: 150_000_000n };
  const principal = 5_000_000_000n;
  const T0 = 1_800_000_000;
  const info = (over: Partial<NativeInfo> = {}): NativeInfo => ({
    position: owner,
    mint: SIM_SOL_MINT,
    stakeRateOpen: 0n,
    stakeRateHigh: 0n,
    custodyShares: principal,
    status: "locked",
    principalLamports: principal,
    rateBps: 700,
    yieldFeeBps: 2000,
    openedAt: T0,
    appliedNet: 0n,
    freeYield: 0n,
    freeYieldClaimed: 0n,
    advances: 1,
    openAdvance: 0,
    source: { key: owner, index: 0, horizonMonths: 1, math: source, fees: null },
    ...over,
  });

  it("derives Debt from the clock with no crank: down with time, zero at the Estimate", () => {
    const i = info();
    const debt0 = debtGemasAt(i, 4380, T0 * 1000);
    const debt5 = debtGemasAt(i, 4380, (T0 + 300) * 1000);
    expect(debt0).toBe(437n);
    expect(debt5 < debt0).toBe(true);
    // A 1-month Advance is repaid in 10 minutes.
    const at = unlockEstimateMs({ clock: clockOf(i), speedup: 4380, appliedNet: 0n, source, nowMs: T0 * 1000 })!;
    expect(at).toBeGreaterThanOrEqual((T0 + 598) * 1000);
    expect(at).toBeLessThanOrEqual((T0 + 600) * 1000);
    expect(debtGemasAt(i, 4380, at)).toBe(0n);
    expect(debtGemasAt(i, 4380, at - 1000)).toBeGreaterThan(0n);
  });

  it("counts only yield after the checkpoint toward the open Advance, and the rest as free yield", () => {
    // Yield at 1,200 s, 5 SOL, 7%: 58,333,333 (gross: the Yield Fee waits for the cash-out). The 437 Gemas need 29,133,334.
    const now = T0 + 1200;
    const i = info();
    const cur = nativeNow(i, 4380, now);
    expect(cur.accrued).toBe(58_333_333n);
    expect(cur.debtGemas).toBe(0n);
    expect(cur.freeUnits).toBe(58_333_333n - 29_133_334n);
    // Yield that accrued before an Advance (applied_net) never repays it.
    const later = nativeNow(info({ appliedNet: 30_000_000n }), 4380, now);
    expect(later.debtGemas).toBeGreaterThan(0n);
    // A closed Source keeps its stored yield for late Redeems.
    const closed = info({ openAdvance: null, source: { key: owner, index: 0, horizonMonths: 1, math: { ...source, yieldUnits: 29_133_334n }, fees: null } });
    expect(sourceAtClock({ ...clockOf(closed), appliedNet: 0n, openAdvance: null }, 0, closed.source!.math, 4380, now).yieldUnits).toBe(29_133_334n);
    expect(nativeNow(closed, 4380, now).debtGemas).toBe(0n);
  });

  it("freezes an Unlocked Position at what it settled", () => {
    const done = info({ status: "unlocked", openAdvance: null, appliedNet: 46_000_000n, freeYield: 20_000_000n, freeYieldClaimed: 20_000_000n });
    const cur = nativeNow(done, 4380, T0 + 10_000_000);
    expect(cur.accrued).toBe(46_000_000n);
    expect(cur.freeUnits).toBe(0n);
  });

  it("has no estimate without an Advance and 'now' when already repaid", () => {
    const clock = clockOf(info());
    expect(unlockEstimateMs({ clock, speedup: 4380, appliedNet: 0n, source: null, nowMs: 0 })).toBeNull();
    expect(unlockEstimateMs({ clock, speedup: 4380, appliedNet: 0n, source, nowMs: (T0 + 5000) * 1000 })).toBe((T0 + 5000) * 1000);
  });

  it("reads a PositionState with the ADR 0010 fields", () => {
    const d = Buffer.alloc(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 5 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 2);
    let o = 8 + 1 + 32 + 32 + 1 + 32 + 1;
    d.writeBigUInt64LE(principal, o);
    d.writeUInt16LE(700, o + 8);
    d[o + 10] = 0;
    d.writeUInt32LE(2, o + 11);
    d[o + 15] = 1; // open_advance = Some(1)
    d.writeUInt32LE(1, o + 16);
    o += 15 + 5 + 8 + 8; // free_yield
    d.writeBigUInt64LE(7n, o);
    d.writeBigUInt64LE(3n, o + 8);
    d.writeBigInt64LE(BigInt(T0), o + 16);
    d.writeBigUInt64LE(9n, o + 24);
    d.writeBigUInt64LE(principal, o + 32);
    d.writeUInt16LE(1500, o + 40);
    const got = nativeInfoFrom(owner, { data: d, executable: false, lamports: 0, owner } as never, null);
    expect(got).toMatchObject({ status: "locked", rateBps: 700, advances: 2, openAdvance: 1, freeYield: 7n, freeYieldClaimed: 3n, openedAt: T0, appliedNet: 9n, yieldFeeBps: 1500, principalLamports: principal });
    expect(poolSpeedup(Buffer.concat([Buffer.alloc(92), Buffer.from([0x0c, 0x11, 0, 0])]))).toBe(4364);
  });

  it("reads the Positions the program writes, of both layouts, as the IDL coder does (ticket 55)", () => {
    const coder = new BorshAccountsCoder(idl as Idl);
    const images: [string, Buffer, bigint | null][] = [
      ["devnet 235 Some", Buffer.from(sizeFixtures.some.data, "base64"), null],
      ["devnet 235 None + stale", Buffer.from(sizeFixtures.noneStale.data, "base64"), null],
      ...Object.entries(stakeFixtures)
        .filter(([k]) => k !== "_note")
        .map(([k, f]: [string, any]) => [k, Buffer.from(f.data, "hex"), BigInt(f.expect.stakeRateHigh ?? 0)] as [string, Buffer, bigint]),
    ];
    for (const [name, data, high] of images) {
      const got = nativeInfoFrom(owner, { data, executable: false, lamports: 0, owner } as never, null);
      const p = decodePosition((d) => coder.decode("PositionState", d), data).inner;
      expect(
        {
          mint: got.mint.toBase58(),
          principal: got.principalLamports,
          rateBps: got.rateBps,
          status: got.status,
          advances: got.advances,
          openAdvance: got.openAdvance,
          freeYield: got.freeYield,
          freeYieldClaimed: got.freeYieldClaimed,
          openedAt: got.openedAt,
          appliedNet: got.appliedNet,
          custodyShares: got.custodyShares,
          yieldFeeBps: got.yieldFeeBps,
          stakeRateOpen: got.stakeRateOpen,
          stakeRateHigh: got.stakeRateHigh,
        },
        name,
      ).toEqual({
        mint: new PublicKey(p.source_asset).toBase58(),
        principal: BigInt(p.principal.toString()),
        rateBps: p.rate_bps,
        status: Object.keys(p.status)[0].toLowerCase(),
        advances: p.advances,
        openAdvance: p.open_advance,
        freeYield: BigInt(p.free_yield.toString()),
        freeYieldClaimed: BigInt(p.free_yield_claimed.toString()),
        openedAt: Number(p.opened_at.toString()),
        appliedNet: BigInt(p.applied_net.toString()),
        custodyShares: BigInt(p.custody_shares.toString()),
        yieldFeeBps: p.yield_fee_bps,
        stakeRateOpen: BigInt(p.stake_rate_open.toString()),
        stakeRateHigh: BigInt(p.stake_rate_high.toString()),
      });
      if (high !== null) expect(got.stakeRateHigh, name).toBe(high);
    }
  });

  it("pays simSOL worth the redeemed units", () => {
    // 15,000 Gemas = $150 = 1 SOL of units; at rate 1.25 that is 0.8 simSOL
    expect(redeemPayoutShares(source, 15_000n, 1_250_000_000n)).toBe(800_000_000n);
  });
});

describe("extend an Advance", () => {
  const price = 150_000_000n;
  const principal = 5_000_000_000n;
  const first = quoteNativeAdvance(principal, 700, 3, price);
  const source = { issued: first.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: price };

  it("mints the added months at the current fee when the fee changed since the Advance", () => {
    const quote = quoteExtendAdvance(principal, 700, source, 3, 3);
    const size = (months: number) => quoteNativeAdvance(principal, 700, months, price).gemas;
    expect(quote.gemas).toBe(size(6) - size(3));
    expect(quote.gemas).toBeGreaterThan(0n);
  });

  it("mints the added months at an unchanged fee, so two extensions equal one", () => {
    const once = quoteExtendAdvance(principal, 700, source, 3, 6);
    expect(once.gemas).toBe(quoteNativeAdvance(principal, 700, 9, price).gemas - first.gemas);
    const a = quoteExtendAdvance(principal, 700, source, 3, 3);
    const b = quoteExtendAdvance(principal, 700, a.extended, 6, 3);
    expect(a.gemas + b.gemas).toBe(once.gemas);
    expect(b.extended.issued).toBe(source.issued + once.gemas);
  });
});
