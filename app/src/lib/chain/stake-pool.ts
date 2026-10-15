import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RATE_SCALE,
  TESORO_CORE_ID,
  TOKEN_PROGRAM_ID,
  accountPda,
  core,
  custodyPda,
  meta,
  pda,
  rdI64,
  rdU64,
  s,
  treasuryPda,
  u64,
  vaultPda,
  positionPda,
  sourcePda,
  takeNativeAdvanceIx,
} from "./native";

/**
 * Real staking tokens on Solana (ADR 0010): the `SolSource` setting names the active token and its SPL stake pool,
 * and a Player holding plain SOL opens a Position in one transaction: the pool's own `DepositSol` mints the token
 * to the Player's token account, then `open_stake_pool_position` takes the minted amount. No swap. The token amount
 * the open asks for is computed here from the pool account with a small slippage floor; if the pool mints less,
 * the open's token transfer fails and the whole transaction reverts, SOL included.
 * Shared with the keeper: web3.js only, relative imports only.
 */

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

export const solSourcePda = () => pda([s("sol_source")]);
export const tokenApyPda = (mint: PublicKey) => pda([s("token_apy"), mint.toBuffer()]);
/** The Treasury's vault of a token other than the one the Treasury was created with. */
export const tokenTreasuryVaultPda = (mint: PublicKey) => pda([s("treasury_vault"), mint.toBuffer()]);
export const tokenAta = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
export const poolWithdrawAuthority = (pool: PublicKey, program = STAKE_POOL_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], program)[0];

// ---- Decoders -------------------------------------------------------------------------------------

export interface SolSourceView {
  mint: PublicKey;
  pool: PublicKey;
}

/** `SolSource`: disc 8, bump, mint, pool. */
export function parseSolSource(d: Uint8Array): SolSourceView | null {
  if (d.length < 8 + 1 + 64) return null;
  return { mint: new PublicKey(d.subarray(9, 41)), pool: new PublicKey(d.subarray(41, 73)) };
}

export interface TokenApyView {
  apyBps: number;
  updatedTs: number;
}

/** `TokenApy`: disc 8, bump, mint, apy_bps u16, updated_ts i64. */
export function parseTokenApy(d: Uint8Array): TokenApyView | null {
  if (d.length < 8 + 1 + 32 + 2 + 8) return null;
  return { apyBps: new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(41, true), updatedTs: Number(rdI64(d, 43)) };
}

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
    if (o + 17 > d.length) return null;
    return { poolMint, reserveStake, managerFeeAccount, totalLamports, poolTokenSupply, solDepositFee, solReferralFee, solDepositAuthority };
  } catch {
    return null;
  }
}

/** SOL base units per pool token, 1e9 fixed point, rounded down (the program's `stake_pool_rate`). Null for an empty pool. */
export function stakePoolRate(totalLamports: bigint, poolTokenSupply: bigint): bigint | null {
  if (poolTokenSupply === 0n || totalLamports === 0n) return null;
  const rate = (totalLamports * RATE_SCALE) / poolTokenSupply;
  return rate > 0n ? rate : null;
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
  return { tokens, openTokens, principalLamports: (openTokens * rate) / RATE_SCALE, problem: openTokens > 0n ? null : "That is too little SOL to stake." };
}

/** Pool tokens `lamports` of Principal would be, for the token path's quote (an exact, fee-free conversion at the rate). */
export const tokensToLamports = (tokens: bigint, rate: bigint) => (tokens * rate) / RATE_SCALE;

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

/** `open_stake_pool_position`: locks `tokenAmount` of the active token from the owner's token account. `position` is `await positionPda(owner, nonce)`. */
export function openStakePoolPositionIx(owner: PublicKey, nonce: bigint | number, tokenAmount: bigint, position: PublicKey, source: SolSourceView) {
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner)),
      meta(solSourcePda()),
      meta(tokenApyPda(source.mint)),
      meta(source.pool),
      meta(source.mint),
      meta(tokenAta(owner, source.mint), true),
      meta(position, true),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "open_stake_pool_position",
    u64(nonce),
    u64(tokenAmount),
  );
}

/**
 * Permissionless crank of a stake pool custody: takes the Yield Fee on the pool rate's growth into the Treasury's vault
 * of the token, then applies the Position's yield to its Debt. `treasuryVault` is the Treasury's vault of the Position's
 * token; `openAdvance` the Position's open Advance index, if any.
 */
export const accrueStakePoolYieldIx = (position: PublicKey, pool: PublicKey, treasuryVault: PublicKey, openAdvance: number | null) =>
  core(
    [
      meta(position, true),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(pool),
      meta(treasuryPda(), true),
      meta(treasuryVault, true),
      meta(TOKEN_PROGRAM_ID),
      // Optional account: the program id stands for `None`.
      meta(openAdvance === null ? TESORO_CORE_ID : sourcePda(position, openAdvance), openAdvance !== null),
    ],
    "accrue_stake_pool_yield",
  );

// ---- One signed flow ------------------------------------------------------------------------------

export interface OpenPlan {
  instructions: TransactionInstruction[];
  position: PublicKey;
  nonce: bigint;
}

/**
 * Plain SOL in, Position out: [create the token account if missing, `DepositSol`, `open_stake_pool_position`, and the first
 * Advance when `months` is given]. All in one transaction, so a failing step leaves the Player with their SOL.
 */
export async function planOpenWithSol(args: {
  owner: PublicKey;
  nonce: bigint;
  lamports: bigint;
  pool: StakePoolView;
  source: SolSourceView;
  months?: number;
}): Promise<OpenPlan> {
  const { owner, pool, source } = args;
  const quote = quoteDepositSol(args.lamports, pool);
  if (quote.problem || quote.openTokens <= 0n) throw new Error(quote.problem ?? "Nothing to stake.");
  const position = await positionPda(owner, args.nonce);
  const dest = tokenAta(owner, source.mint);
  const instructions = [
    createAtaIdempotentIx(owner, owner, source.mint),
    depositSolIx({ pool: source.pool, view: pool, from: owner, dest, lamports: args.lamports }),
    openStakePoolPositionIx(owner, args.nonce, quote.openTokens, position, source),
  ];
  if (args.months) instructions.push(takeNativeAdvanceIx(owner, position, 0, args.months, source.mint));
  return { instructions, position, nonce: args.nonce };
}

/** The token the Player already holds goes straight into the Position (and the first Advance when `months` is given). */
export async function planOpenWithToken(args: { owner: PublicKey; nonce: bigint; tokens: bigint; source: SolSourceView; months?: number }): Promise<OpenPlan> {
  const { owner, source } = args;
  if (args.tokens <= 0n) throw new Error("Nothing to lock.");
  const position = await positionPda(owner, args.nonce);
  const instructions = [openStakePoolPositionIx(owner, args.nonce, args.tokens, position, source)];
  if (args.months) instructions.push(takeNativeAdvanceIx(owner, position, 0, args.months, source.mint));
  return { instructions, position, nonce: args.nonce };
}
