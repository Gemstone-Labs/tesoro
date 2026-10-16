import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ID } from "./native";
import {
  DEPOSIT_SLIPPAGE_BPS,
  STAKE_POOL_PROGRAM_ID,
  depositSolIx,
  isStale,
  sizingApyBps,
  parseStakePool,
  poolWithdrawAuthority,
  quoteDepositSol,
  stakePoolRate,
  tokenAta,
  tokenSymbol,
  type StakePoolView,
} from "./stake-pool";

const JITO_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const JITO_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const SOL = 1_000_000_000n;

/** The live jitoSOL pool account (read from mainnet-beta 2026-10-15), shared with the tesoro_core LiteSVM tests. */
const livePool = readFileSync(join(__dirname, "../../../../programs/tesoro_core/tests/fixtures/jito_pool.bin"));
const view = parseStakePool(livePool)!;

describe("stake pool account", () => {
  it("reads the live jitoSOL pool: mint, reserve, balances and a zero SOL deposit fee", () => {
    expect(view.poolMint.toBase58()).toBe(JITO_MINT.toBase58());
    expect(view.reserveStake.toBase58()).toBe("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL");
    expect(view.managerFeeAccount.toBase58()).toBe("8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa");
    expect(view.totalLamports).toBe(10_475_185_838_136_915n);
    expect(view.poolTokenSupply).toBe(8_018_218_559_544_148n);
    expect(view.solDepositFee).toEqual({ numerator: 0n, denominator: 0n });
    expect(view.solDepositAuthority).toBeNull();
    expect(stakePoolRate(view.totalLamports, view.poolTokenSupply)).toBe((view.totalLamports * 10n ** 12n) / view.poolTokenSupply);
  });

  it("walks the optional fields: a pool with a next epoch fee, preferred validators and a deposit fee", () => {
    const d = Buffer.from(livePool);
    // Rebuild the tail of the account with the optionals set, keeping the fixed head.
    const head = d.subarray(0, 346);
    const tail = Buffer.concat([
      Buffer.from([1]), Buffer.alloc(16), // next_epoch_fee: One(fee)
      Buffer.from([1]), Buffer.alloc(32, 7), // preferred deposit validator
      Buffer.from([0]), // preferred withdraw validator
      Buffer.alloc(32), // stake deposit + withdrawal fee
      Buffer.from([2]), Buffer.alloc(16), // next_stake_withdrawal_fee: Two(fee)
      Buffer.from([0]), // stake_referral_fee
      Buffer.from([0]), // sol_deposit_authority: None
      (() => { const b = Buffer.alloc(16); b.writeBigUInt64LE(1000n, 0); b.writeBigUInt64LE(3n, 8); return b; })(), // 0.3%
      Buffer.from([25]), // sol_referral_fee
      Buffer.alloc(200),
    ]);
    const v = parseStakePool(Buffer.concat([head, tail]))!;
    expect(v.solDepositFee).toEqual({ numerator: 3n, denominator: 1000n });
    expect(v.solReferralFee).toBe(25);
    expect(v.solDepositAuthority).toBeNull();
  });

  it("reads the update epoch and the previous epoch's totals the way the program does", () => {
    expect(view.lastUpdateEpoch).toBe(1058n);
    expect(view.lastEpochPoolTokenSupply).toBe(8_013_714_481_593_944n);
    expect(view.lastEpochTotalLamports).toBe(10_467_917_186_112_723n);
    // The same numbers the Rust unit test pins (`the_live_jitosol_pool_sizes_below_a_generous_ceiling`).
    const apy = sizingApyBps(view, 2000);
    expect(apy).toBeGreaterThan(0);
    expect(apy).toBeLessThan(600);
  });

  it("sizes an Advance on one epoch of growth, capped, exactly like StakePoolRead::sizing_apy_bps", () => {
    const p = { totalLamports: 1_000_400_000n, poolTokenSupply: 1_000_000_000n, lastEpochTotalLamports: 1_000_000_000n, lastEpochPoolTokenSupply: 1_000_000_000n };
    expect(sizingApyBps(p, 2000)).toBe(648);
    expect(sizingApyBps(p, 500)).toBe(500);
    expect(sizingApyBps({ ...p, lastEpochTotalLamports: 0n, lastEpochPoolTokenSupply: 0n }, 2000)).toBe(0);
    expect(sizingApyBps({ ...p, totalLamports: 999_000_000n }, 2000)).toBe(0);
    // The round pool of tests/stake.rs: 1.30 now, 1.29948 a epoch ago.
    expect(sizingApyBps({ totalLamports: 1_300_000_000_000n, poolTokenSupply: 1_000_000_000_000n, lastEpochTotalLamports: 1_299_480_000_000n, lastEpochPoolTokenSupply: 1_000_000_000_000n }, 2000)).toBe(649);
  });

  it("calls a pool stale when its update is more than one epoch behind", () => {
    expect(isStale({ lastUpdateEpoch: 100n }, 101)).toBe(false);
    expect(isStale({ lastUpdateEpoch: 100n }, 102)).toBe(true);
    expect(isStale({ lastUpdateEpoch: 100n }, 50)).toBe(false);
  });

  it("refuses data that is not an initialised stake pool", () => {
    expect(parseStakePool(Buffer.alloc(611))).toBeNull();
    expect(parseStakePool(livePool.subarray(0, 100))).toBeNull();
  });
});

describe("deposit quote", () => {
  it("mints lamports * supply / total, floored, and opens with a small margin under it", () => {
    const pool: StakePoolView = { ...view, totalLamports: 1_200n * SOL, poolTokenSupply: 1_000n * SOL };
    const q = quoteDepositSol(12n * SOL, pool);
    expect(q.tokens).toBe(10n * SOL);
    expect(q.openTokens).toBe((10n * SOL * (10_000n - DEPOSIT_SLIPPAGE_BPS)) / 10_000n);
    expect(q.principalLamports).toBe((q.openTokens * 1_200_000_000_000n) / 10n ** 12n);
    expect(q.principalLamports).toBeLessThanOrEqual(12n * SOL);
    expect(q.problem).toBeNull();
  });

  it("takes the pool's deposit fee (rounded up) off the minted tokens", () => {
    const pool: StakePoolView = { ...view, totalLamports: 1_000n * SOL, poolTokenSupply: 1_000n * SOL, solDepositFee: { numerator: 3n, denominator: 1000n } };
    expect(quoteDepositSol(10n * SOL, pool).tokens).toBe(10n * SOL - (10n * SOL * 3n) / 1000n);
    expect(quoteDepositSol(1n, pool).tokens).toBe(0n);
  });

  it("says so when the pool needs a deposit authority, is empty, or the amount is dust", () => {
    expect(quoteDepositSol(SOL, { ...view, solDepositAuthority: Keypair.generate().publicKey }).problem).toMatch(/does not take deposits/);
    expect(quoteDepositSol(SOL, { ...view, poolTokenSupply: 0n }).problem).toMatch(/not ready/);
    expect(quoteDepositSol(1n, view).problem).toMatch(/too little/);
    expect(quoteDepositSol(0n, view).problem).toBeNull();
  });
});

describe("instructions", () => {
  const owner = Keypair.generate().publicKey;
  const dest = tokenAta(owner, JITO_MINT);

  it("encodes DepositSol as instruction 14 with the pool's ten accounts", () => {
    const ix = depositSolIx({ pool: JITO_POOL, view, from: owner, dest, lamports: 3n * SOL });
    expect(ix.programId.equals(STAKE_POOL_PROGRAM_ID)).toBe(true);
    expect([...ix.data]).toEqual([14, ...new Uint8Array(new BigUint64Array([3n * SOL]).buffer)]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [JITO_POOL.toBase58(), false, true],
      [poolWithdrawAuthority(JITO_POOL).toBase58(), false, false],
      [view.reserveStake.toBase58(), false, true],
      [owner.toBase58(), true, true],
      [dest.toBase58(), false, true],
      [view.managerFeeAccount.toBase58(), false, true],
      [dest.toBase58(), false, true],
      [JITO_MINT.toBase58(), false, true],
      ["11111111111111111111111111111111", false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ]);
  });

  it("derives the pool's withdraw authority the way the program does", () => {
    // The live jitoSOL mint's authority is this PDA.
    expect(poolWithdrawAuthority(JITO_POOL).toBase58()).toBe(
      PublicKey.findProgramAddressSync([JITO_POOL.toBuffer(), Buffer.from("withdraw")], STAKE_POOL_PROGRAM_ID)[0].toBase58(),
    );
  });

  it("names the jitoSOL mint and calls any other mint staked SOL", () => {
    expect(tokenSymbol(JITO_MINT)).toBe("jitoSOL");
    expect(tokenSymbol(owner)).toBe("staked SOL");
  });
});
