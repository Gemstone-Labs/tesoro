import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, meta, rdU64, u64 } from "./native";

/**
 * Pure helpers for an SPL stake pool (jitoSOL and kin): the account decoder, the Staking Rate, the Advance sizing APY from
 * the pool's last epoch, a `DepositSol` quote and its instruction builder. They mirror `ledger/stake.rs` and
 * `ledger/stake_pool.rs` of tesoro_core (ADR 0011). Nothing here talks to tesoro_core (see stake.ts).
 * Shared with the keeper: web3.js only, relative imports only.
 */

/** Staking Rate fixed point: lamports per pool token, 1e12 (`STAKE_RATE_SCALE`). */
export const STAKE_RATE_SCALE = 1_000_000_000_000n;
/** The epoch length Advance sizing assumes: 432,000 slots at 450 ms (`EPOCH_SECS`). */
export const EPOCH_SECS = 194_400n;
const YEAR_SECS = 31_536_000n;
/** The program refuses a pool whose last update is more than this many epochs behind the clock. */
export const MAX_STALE_EPOCHS = 1;

export const STAKE_POOL_PROGRAM_ID = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
/** Instruction 14 of the SPL stake pool program. */
const DEPOSIT_SOL = 14;
/** Slippage the Player accepts between the quote and the block the deposit lands in. */
export const DEPOSIT_SLIPPAGE_BPS = 50n;
const BPS = 10_000n;

/** Staking tokens the app names; any other mint is "staked SOL". */
const KNOWN_TOKENS: Record<string, string> = { J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "jitoSOL" };
export const tokenSymbol = (mint: PublicKey) => KNOWN_TOKENS[mint.toBase58()] ?? "staked SOL";

// ---- Addresses ------------------------------------------------------------------------------------

export const tokenAta = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
export const poolWithdrawAuthority = (pool: PublicKey, program = STAKE_POOL_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], program)[0];

// ---- Decoders -------------------------------------------------------------------------------------

export interface Fee {
  numerator: bigint;
  denominator: bigint;
}

export interface StakePoolView {
  poolMint: PublicKey;
  reserveStake: PublicKey;
  managerFeeAccount: PublicKey;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  /** Fee on SOL deposits, taken in pool tokens. */
  solDepositFee: Fee;
  /** Percentage (0-100) of the deposit fee paid to the referrer. */
  solReferralFee: number;
  /** When set, `DepositSol` needs this key's signature: a plain Player cannot deposit. */
  solDepositAuthority: PublicKey | null;
  /** Epoch of the pool's last balance update. */
  lastUpdateEpoch: bigint;
  /** The totals one update earlier: with the current ones they give an epoch of growth. Zero before the first roll. */
  lastEpochTotalLamports: bigint;
  lastEpochPoolTokenSupply: bigint;
}

/**
 * A `StakePool` account (borsh, no discriminator). The fields before `sol_deposit_fee` hold optional values, so the
 * offsets are walked rather than fixed. Null when the data is not an initialised stake pool.
 */
export function parseStakePool(d: Uint8Array): StakePoolView | null {
  if (d.length < 275 || d[0] !== 1) return null;
  const key = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const fee = (o: number): Fee => ({ denominator: rdU64(d, o), numerator: rdU64(d, o + 8) });
  try {
    // type, manager, staker, stake_deposit_authority, bump, validator_list, reserve_stake, pool_mint, manager_fee_account, token_program
    const reserveStake = key(130);
    const poolMint = key(162);
    const managerFeeAccount = key(194);
    const totalLamports = rdU64(d, 258);
    const poolTokenSupply = rdU64(d, 266);
    const lastUpdateEpoch = rdU64(d, 274);
    // last_update_epoch (8), lockup (8 + 8 + 32), epoch_fee (16)
    let o = 274 + 8 + 48 + 16;
    o += d[o] ? 17 : 1; // next_epoch_fee
    o += d[o] ? 33 : 1; // preferred_deposit_validator
    o += d[o] ? 33 : 1; // preferred_withdraw_validator
    o += 32; // stake_deposit_fee, stake_withdrawal_fee
    o += d[o] ? 17 : 1; // next_stake_withdrawal_fee
    o += 1; // stake_referral_fee
    const solDepositAuthority = d[o] ? key(o + 1) : null;
    o += d[o] ? 33 : 1;
    const solDepositFee = fee(o);
    const solReferralFee = d[o + 16];
    o += 17;
    o += d[o] ? 33 : 1; // sol_withdraw_authority
    o += 16; // sol_withdrawal_fee
    o += d[o] ? 17 : 1; // next_sol_withdrawal_fee
    if (o + 16 > d.length) return null;
    const lastEpochPoolTokenSupply = rdU64(d, o);
    const lastEpochTotalLamports = rdU64(d, o + 8);
    return {
      poolMint,
      reserveStake,
      managerFeeAccount,
      totalLamports,
      poolTokenSupply,
      solDepositFee,
      solReferralFee,
      solDepositAuthority,
      lastUpdateEpoch,
      lastEpochTotalLamports,
      lastEpochPoolTokenSupply,
    };
  } catch {
    return null;
  }
}

/** SOL base units per pool token, 1e12 fixed point, rounded down (the program's `staking_rate`). Null for an empty pool. */
export function stakePoolRate(totalLamports: bigint, poolTokenSupply: bigint): bigint | null {
  if (poolTokenSupply === 0n || totalLamports === 0n) return null;
  const rate = (totalLamports * STAKE_RATE_SCALE) / poolTokenSupply;
  return rate > 0n ? rate : null;
}

/** True when the pool's last update is further behind `epoch` than the program accepts (`StakePoolRead::require_fresh`). */
export const isStale = (pool: Pick<StakePoolView, "lastUpdateEpoch">, epoch: bigint | number) => BigInt(epoch) > pool.lastUpdateEpoch + BigInt(MAX_STALE_EPOCHS);

/**
 * The annual growth, in basis points, an Advance is sized on: the pool's last epoch (current rate against the rate one
 * update earlier) scaled to a year, capped at `ceilingBps`. Zero without a previous epoch or without growth.
 * Exactly `StakePoolRead::sizing_apy_bps`.
 */
export function sizingApyBps(pool: Pick<StakePoolView, "totalLamports" | "poolTokenSupply" | "lastEpochTotalLamports" | "lastEpochPoolTokenSupply">, ceilingBps: number): number {
  const now = stakePoolRate(pool.totalLamports, pool.poolTokenSupply);
  const before = stakePoolRate(pool.lastEpochTotalLamports, pool.lastEpochPoolTokenSupply);
  if (!now || !before || now <= before) return 0;
  const annual = ((now - before) * BPS * YEAR_SECS) / (before * EPOCH_SECS);
  return Number(annual < BigInt(ceilingBps) ? annual : BigInt(ceilingBps));
}

// ---- Quote ----------------------------------------------------------------------------------------

export interface DepositQuote {
  /** Pool tokens the Player receives for the SOL, after the deposit fee. */
  tokens: bigint;
  /** What `open_stake_pool_position` is asked for: `tokens` less the slippage margin. */
  openTokens: bigint;
  /** SOL base units the opened tokens are worth at the pool's rate: the Position's Principal. */
  principalLamports: bigint;
  /** Why the deposit cannot go ahead, in a Player's words; null when it can. */
  problem: string | null;
}

const feeOf = (amount: bigint, f: Fee) => (f.numerator === 0n || f.denominator === 0n ? 0n : (amount * f.numerator + f.denominator - 1n) / f.denominator);

/**
 * The pool's `DepositSol` arithmetic: tokens = lamports * supply / total (floored), less the deposit fee (rounded up).
 * The referral share of the fee goes back to the Player's own token account, so this is a floor.
 */
export function quoteDepositSol(lamports: bigint, pool: StakePoolView, slippageBps: bigint = DEPOSIT_SLIPPAGE_BPS): DepositQuote {
  const none = (problem: string | null): DepositQuote => ({ tokens: 0n, openTokens: 0n, principalLamports: 0n, problem });
  if (lamports <= 0n) return none(null);
  if (pool.solDepositAuthority) return none("This staking pool does not take deposits from wallets right now.");
  const rate = stakePoolRate(pool.totalLamports, pool.poolTokenSupply);
  if (!rate) return none("This staking pool is not ready.");
  const minted = (lamports * pool.poolTokenSupply) / pool.totalLamports;
  const tokens = minted - feeOf(minted, pool.solDepositFee);
  const openTokens = (tokens * (BPS - slippageBps)) / BPS;
  return { tokens, openTokens, principalLamports: (openTokens * rate) / STAKE_RATE_SCALE, problem: openTokens > 0n ? null : "That is too little SOL to stake." };
}

/** Pool tokens `lamports` of Principal would be, for the token path's quote (an exact, fee-free conversion at the rate). */
export const tokensToLamports = (tokens: bigint, rate: bigint) => (tokens * rate) / STAKE_RATE_SCALE;

// ---- Instructions ---------------------------------------------------------------------------------

/** Creates the owner's token account of `mint` if it is missing (rent paid by `payer`). */
export const createAtaIdempotentIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [meta(payer, true, true), meta(tokenAta(owner, mint), true), meta(owner), meta(mint), meta(SystemProgram.programId), meta(TOKEN_PROGRAM_ID)],
    data: Buffer.from([1]),
  });

/** The pool's `DepositSol`: `lamports` leave `from` for the reserve, pool tokens are minted into `dest` (which also stands in as the referrer). */
export function depositSolIx(args: { pool: PublicKey; view: StakePoolView; from: PublicKey; dest: PublicKey; lamports: bigint; program?: PublicKey }) {
  const program = args.program ?? STAKE_POOL_PROGRAM_ID;
  return new TransactionInstruction({
    programId: program,
    keys: [
      meta(args.pool, true),
      meta(poolWithdrawAuthority(args.pool, program)),
      meta(args.view.reserveStake, true),
      meta(args.from, true, true),
      meta(args.dest, true),
      meta(args.view.managerFeeAccount, true),
      meta(args.dest, true),
      meta(args.view.poolMint, true),
      meta(SystemProgram.programId),
      meta(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.concat([Buffer.from([DEPOSIT_SOL]), u64(args.lamports)]),
  });
}
