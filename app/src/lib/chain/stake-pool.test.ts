import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionMessage } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { TESORO_CORE_ID, TOKEN_PROGRAM_ID, positionPda } from "./native";
import {
  DEPOSIT_SLIPPAGE_BPS,
  STAKE_POOL_PROGRAM_ID,
  accrueStakePoolYieldIx,
  depositSolIx,
  openStakePoolPositionIx,
  parseSolSource,
  parseStakePool,
  MAX_APY_AGE_SECS,
  effectiveApyBps,
  parseTokenApy,
  setTokenApyCeilingIx,
  setTokenApyIx,
  planOpenWithSol,
  planOpenWithToken,
  poolWithdrawAuthority,
  quoteDepositSol,
  solSourcePda,
  stakePoolRate,
  tokenApyPda,
  tokenAta,
  tokenSymbol,
  tokenTreasuryVaultPda,
  type StakePoolView,
} from "./stake-pool";

const JITO_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const JITO_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const source = { mint: JITO_MINT, pool: JITO_POOL };
const SOL = 1_000_000_000n;

/** The live jitoSOL pool account (read from mainnet-beta 2026-10-15), shared with the tesoro_core LiteSVM tests. */
const livePool = readFileSync(join(__dirname, "../../../../programs/tesoro_core/tests/fixtures/jito_pool.bin"));
const view = parseStakePool(livePool)!;
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);

describe("stake pool account", () => {
  it("reads the live jitoSOL pool: mint, reserve, balances and a zero SOL deposit fee", () => {
    expect(view.poolMint.toBase58()).toBe(JITO_MINT.toBase58());
    expect(view.reserveStake.toBase58()).toBe("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL");
    expect(view.managerFeeAccount.toBase58()).toBe("8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa");
    expect(view.totalLamports).toBe(10_475_185_838_136_915n);
    expect(view.poolTokenSupply).toBe(8_018_218_559_544_148n);
    expect(view.solDepositFee).toEqual({ numerator: 0n, denominator: 0n });
    expect(view.solDepositAuthority).toBeNull();
    expect(stakePoolRate(view.totalLamports, view.poolTokenSupply)).toBe((view.totalLamports * SOL) / view.poolTokenSupply);
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

  it("refuses data that is not an initialised stake pool", () => {
    expect(parseStakePool(Buffer.alloc(611))).toBeNull();
    expect(parseStakePool(livePool.subarray(0, 100))).toBeNull();
  });

  it("decodes the SolSource setting and a published APY", () => {
    const src = Buffer.concat([Buffer.alloc(9), JITO_MINT.toBuffer(), JITO_POOL.toBuffer()]);
    expect(parseSolSource(src)).toEqual({ mint: JITO_MINT, pool: JITO_POOL });
    const apy = Buffer.alloc(8 + 1 + 32 + 2 + 8 + 2);
    apy.writeUInt16LE(612, 41);
    apy.writeBigInt64LE(1_800_000_000n, 43);
    apy.writeUInt16LE(500, 51);
    expect(parseTokenApy(apy)).toEqual({ apyBps: 612, updatedTs: 1_800_000_000, ceilingBps: 500 });
    expect(parseTokenApy(apy.subarray(0, 51))).toBeNull();
    expect(parseSolSource(Buffer.alloc(10))).toBeNull();
  });
});

describe("effective APY", () => {
  const apy = { apyBps: 612, updatedTs: 1_800_000_000, ceilingBps: 500 };
  const now = apy.updatedTs + 3600;
  it("is the lower of the published APY and the ceiling", () => {
    expect(effectiveApyBps(apy, now)).toBe(500);
    expect(effectiveApyBps({ ...apy, ceilingBps: 900 }, now)).toBe(612);
  });
  it("is null with no ceiling, no APY or a published APY older than 3 days", () => {
    expect(effectiveApyBps({ ...apy, ceilingBps: 0 }, now)).toBeNull();
    expect(effectiveApyBps(null, now)).toBeNull();
    expect(effectiveApyBps(apy, apy.updatedTs + MAX_APY_AGE_SECS)).toBe(500);
    expect(effectiveApyBps(apy, apy.updatedTs + MAX_APY_AGE_SECS + 1)).toBeNull();
  });
  it("builds the oracle and admin instructions the program expects", () => {
    const owner = Keypair.generate().publicKey;
    expect(setTokenApyIx(owner, JITO_MINT, 450).data.toString("hex")).toBe("34cd6ebb705abe74c201");
    expect(setTokenApyCeilingIx(owner, JITO_MINT, 450).data.toString("hex")).toBe("040a50fce0d7d95ac201");
  });
});

describe("deposit quote", () => {
  it("mints lamports * supply / total, floored, and opens with a small margin under it", () => {
    const pool: StakePoolView = { ...view, totalLamports: 1_200n * SOL, poolTokenSupply: 1_000n * SOL };
    const q = quoteDepositSol(12n * SOL, pool);
    expect(q.tokens).toBe(10n * SOL);
    expect(q.openTokens).toBe((10n * SOL * (10_000n - DEPOSIT_SLIPPAGE_BPS)) / 10_000n);
    expect(q.principalLamports).toBe((q.openTokens * 1_200_000_000n) / SOL);
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

  it("uses Anchor discriminators sha256('global:<name>')[..8]", async () => {
    const position = await positionPda(owner, 5n);
    expect(openStakePoolPositionIx(owner, 5n, 9n, position, source).data.subarray(0, 8)).toEqual(disc("open_stake_pool_position"));
    expect(accrueStakePoolYieldIx(position, JITO_POOL, tokenTreasuryVaultPda(JITO_MINT), null).data).toEqual(disc("accrue_stake_pool_yield"));
  });

  it("opens with the named accounts the program requires, in order", async () => {
    const position = await positionPda(owner, 5n);
    const ix = openStakePoolPositionIx(owner, 5n, 9n, position, source);
    const k = ix.keys.map((m) => m.pubkey.toBase58());
    expect(k.slice(0, 8)).toEqual([owner, undefined, solSourcePda(), tokenApyPda(JITO_MINT), JITO_POOL, JITO_MINT, dest, position].map((x) => x?.toBase58() ?? k[1]));
    expect(ix.programId.equals(TESORO_CORE_ID)).toBe(true);
    expect(ix.data.readBigUInt64LE(8)).toBe(5n);
    expect(ix.data.readBigUInt64LE(16)).toBe(9n);
    expect(ix.keys[6].isWritable).toBe(true);
  });

  it("passes the program id for a missing open Advance in the crank", async () => {
    const position = await positionPda(owner, 5n);
    const none = accrueStakePoolYieldIx(position, JITO_POOL, tokenTreasuryVaultPda(JITO_MINT), null);
    expect(none.keys[7]).toMatchObject({ isWritable: false });
    expect(none.keys[7].pubkey.equals(TESORO_CORE_ID)).toBe(true);
    const some = accrueStakePoolYieldIx(position, JITO_POOL, tokenTreasuryVaultPda(JITO_MINT), 2);
    expect(some.keys[7].isWritable).toBe(true);
    expect(some.keys[7].pubkey.equals(TESORO_CORE_ID)).toBe(false);
  });
});

describe("opening with plain SOL", () => {
  const owner = Keypair.generate().publicKey;

  it("composes token account, DepositSol, open and the Advance in one transaction, with no swap", async () => {
    const plan = await planOpenWithSol({ owner, nonce: 7n, lamports: 10n * SOL, pool: view, source, months: 12 });
    const programs = plan.instructions.map((i) => i.programId.toBase58());
    expect(programs).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      STAKE_POOL_PROGRAM_ID.toBase58(),
      TESORO_CORE_ID.toBase58(),
      TESORO_CORE_ID.toBase58(),
    ]);
    const quote = quoteDepositSol(10n * SOL, view);
    expect(plan.instructions[1].data.readBigUInt64LE(1)).toBe(10n * SOL);
    expect(plan.instructions[2].data.readBigUInt64LE(16)).toBe(quote.openTokens);
    expect(plan.instructions[2].data.readBigUInt64LE(16)).toBeLessThan(quote.tokens);
    // Only the Player signs; nothing from a DEX is in the transaction.
    const signers = new Set(plan.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
    expect([...signers]).toEqual([owner.toBase58()]);
  });

  it("fits one legacy transaction with the Account creation in front", async () => {
    const plan = await planOpenWithSol({ owner, nonce: 7n, lamports: 10n * SOL, pool: view, source, months: 12 });
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: plan.instructions }).compileToLegacyMessage();
    // 1 signature (64) + message; the packet limit is 1232 bytes.
    expect(64 + msg.serialize().length).toBeLessThanOrEqual(1232);
  });

  it("refuses a deposit the pool would not take", async () => {
    await expect(planOpenWithSol({ owner, nonce: 1n, lamports: 1n, pool: view, source })).rejects.toThrow(/too little/);
    await expect(planOpenWithSol({ owner, nonce: 1n, lamports: SOL, pool: { ...view, solDepositAuthority: owner }, source })).rejects.toThrow(/does not take deposits/);
  });

  it("locks the token a Player already holds without a deposit", async () => {
    const plan = await planOpenWithToken({ owner, nonce: 3n, tokens: 4n * SOL, source, months: 6 });
    expect(plan.instructions.map((i) => i.programId.toBase58())).toEqual([TESORO_CORE_ID.toBase58(), TESORO_CORE_ID.toBase58()]);
    expect(plan.instructions[0].data.readBigUInt64LE(16)).toBe(4n * SOL);
    await expect(planOpenWithToken({ owner, nonce: 3n, tokens: 0n, source })).rejects.toThrow();
  });

  it("names the jitoSOL mint and calls any other mint staked SOL", () => {
    expect(tokenSymbol(JITO_MINT)).toBe("jitoSOL");
    expect(tokenSymbol(owner)).toBe("staked SOL");
  });
});
