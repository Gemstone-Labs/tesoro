import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type AccountMeta } from "@solana/web3.js";
import { ROUTE_LEN, parseRoute, parseTreasury, type RouteView } from "./fees";
import {
  CONFIG,
  TESORO_CORE_ID,
  TOKEN_PROGRAM_ID,
  accountPda,
  extendLimitPda,
  meta,
  onchainPricePda,
  parseSolPrice,
  pda,
  protectionsPda,
  pythFeedAddress,
  rdU16,
  rdU64,
  s,
  solPriceKey,
  sourcePda,
  treasuryAccountPda,
  treasuryPda,
  u64,
  type NativeMarket,
} from "./native";
import { coreIx } from "./core-ix";
import { basketPda, bookPda, spillPda } from "./basket";
import { lineArg, type LineTarget, type PrevAdvance } from "./native";
import { STAKE_POOL_PROGRAM_ID, STAKE_RATE_SCALE, parseStakePool, sizingApyBps, stakePoolRate, tokenAta, tokenSymbol, type StakePoolView } from "./stake-pool";

/**
 * Mainnet SOL Positions on a real staking token (ADR 0011, computed model of ADR 0010): addresses, instruction encoders,
 * the market read and the Treasury mirror. Mirrors `programs/tesoro_core/src/instructions/stake.rs` and `ledger/stake.rs`;
 * the encoders are checked against the IDL in stake.test.ts. The yield itself goes through `positionAccrued` with a
 * `StakeGrowth` (yield.ts), the same formula as every network. Shared with the keeper: web3.js only, relative imports only.
 */

/** A staking token the app knows how to read: the mint and the stake pool its Staking Rate comes from. The program's setting decides which one is active. */
export interface StakeToken {
  symbol: string;
  mint: PublicKey;
  pool: PublicKey;
  /** The program that owns the pool account (`STAKE_POOL_PROGRAMS` in the program). */
  poolProgram: PublicKey;
}

export const JITOSOL: StakeToken = {
  symbol: "jitoSOL",
  mint: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
  pool: new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"),
  poolProgram: STAKE_POOL_PROGRAM_ID,
};
/** Tokens the Wallet can show. The first is read by default; changing the partner adds one here and in the program's setting. */
export const STAKE_TOKENS: readonly StakeToken[] = [JITOSOL];
export const stakeTokenOf = (mint: PublicKey) => STAKE_TOKENS.find((t) => t.mint.equals(mint)) ?? null;

// ---- Addresses -----------------------------------------------------------------------------------

export const stakeConfigPda = () => pda([s("stake_config")]);
export const stakeCustodyPda = (mint: PublicKey) => pda([s("stake_custody"), mint.toBuffer()]);
export const stakeVaultPda = (mint: PublicKey) => pda([s("stake_vault"), mint.toBuffer()]);

/** Same derivation as `stake_position_id` on chain: sha256("stake" || owner || nonce_le). */
export async function stakePositionId(owner: PublicKey, nonce: bigint | number): Promise<Buffer> {
  return Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", Buffer.concat([s("stake"), owner.toBuffer(), u64(nonce)])));
}
export async function stakePositionPda(owner: PublicKey, nonce: bigint | number): Promise<PublicKey> {
  return pda([s("position"), Buffer.from([0]), await stakePositionId(owner, nonce)]);
}

// ---- Instructions --------------------------------------------------------------------------------

/** Deposits `shares` of the active staking token as a new Position (Principal recorded at the pool's rate now). `position` is `await stakePositionPda(owner, nonce)`. */
export function openStakePositionIx(owner: PublicKey, nonce: bigint | number, shares: bigint, position: PublicKey, token: StakeToken = JITOSOL) {
  return coreIx(
    "open_stake_position",
    {
      owner_authority: owner,
      owner_account: accountPda(owner),
      stake_config: stakeConfigPda(),
      mint: token.mint,
      custody: stakeCustodyPda(token.mint),
      vault: stakeVaultPda(token.mint),
      owner_token: tokenAta(owner, token.mint),
      stake_pool: token.pool,
      treasury: treasuryPda(),
      position,
      token_program: TOKEN_PROGRAM_ID,
    },
    { nonce: BigInt(nonce), shares },
  );
}

/**
 * An Advance on a staking-token Position: priced from the token's Pyth mapping, sized on the pool's last-epoch growth.
 * `prev` is the open Advance, closed here (its Source, then its book and checkpoint pages).
 */
export function takeStakeAdvanceIx(owner: PublicKey, position: PublicKey, advances: number, months: number, prev: PrevAdvance | null = null, token: StakeToken = JITOSOL) {
  const source = sourcePda(position, advances);
  const account = accountPda(owner);
  return coreIx(
    "take_stake_advance",
    {
      owner_authority: owner,
      owner_account: account,
      protections: protectionsPda(account),
      position,
      onchain_price: onchainPricePda(token.mint),
      price_feed: pythFeedAddress("SOL"),
      stake_config: stakeConfigPda(),
      custody: stakeCustodyPda(token.mint),
      stake_pool: token.pool,
      source,
      book: bookPda(source),
      basket: basketPda(account),
      spill: spillPda(account),
    },
    { horizon_months: months },
    prev ? [meta(sourcePda(position, prev.index)), ...prev.accounts.map((k) => meta(k, true))] : [],
  );
}

/** Adds months to the open Advance of a staking-token Position. `book` is the Source's book and checkpoint pages. */
export function extendStakeAdvanceIx(owner: PublicKey, position: PublicKey, source: number, extraMonths: number, book: PublicKey[], token: StakeToken = JITOSOL) {
  const account = accountPda(owner);
  return coreIx(
    "extend_stake_advance",
    {
      owner_authority: owner,
      owner_account: account,
      protections: protectionsPda(account),
      position,
      stake_config: stakeConfigPda(),
      custody: stakeCustodyPda(token.mint),
      stake_pool: token.pool,
      source: sourcePda(position, source),
      basket: basketPda(account),
      spill: spillPda(account),
      extend_limit: extendLimitPda(account),
    },
    { extra_months: extraMonths },
    book.map((k) => meta(k, true)),
  );
}

/** The accounts a stake Position's `return_own` adds after its own, when nothing is paid out: the custody and the pool. */
export const stakeRateRemaining = (token: StakeToken = JITOSOL): AccountMeta[] => [meta(stakeCustodyPda(token.mint), true), meta(token.pool)];

/** The same when the instruction pays the token out to `dest`: custody, pool, vault, destination, token program. */
export const stakePayingAccounts = (dest: PublicKey, token: StakeToken = JITOSOL): AccountMeta[] => [
  ...stakeRateRemaining(token),
  meta(stakeVaultPda(token.mint), true),
  meta(dest, true),
  meta(TOKEN_PROGRAM_ID),
];

/** Redeem Gemas of one line of a stake Source: the holder is paid the staking token into their own token account (it must exist). */
export function redeemStakeIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint, target: LineTarget, token: StakeToken = JITOSOL) {
  const account = accountPda(holder);
  return coreIx(
    "redeem",
    { holder_authority: holder, holder_account: account, basket: basketPda(account), spill: spillPda(account), position, source },
    { line: lineArg(target.line), amount: gemas },
    [...stakePayingAccounts(tokenAta(holder, token.mint), token), ...target.accounts.map((k) => meta(k, true))],
  );
}

/** Unlock: Debt is computed by the program and must be zero; Principal and the free yield return in the token. `open` is the open Advance, closed here. */
export function unlockStakeIx(owner: PublicKey, position: PublicKey, open: PrevAdvance | null = null, token: StakeToken = JITOSOL) {
  return coreIx(
    "unlock",
    { owner_authority: owner, owner_account: accountPda(owner), economy: pda([s("economy")]), position },
    {},
    [...stakePayingAccounts(tokenAta(owner, token.mint), token), ...(open ? [meta(sourcePda(position, open.index), true), ...open.accounts.map((k) => meta(k, true))] : [])],
  );
}

/** Permissionless: the Treasury Account redeems Gemas it bought; the value stays in the vault and joins the Treasury's balance. */
export function redeemTreasuryStakeIx(position: PublicKey, source: PublicKey, gemas: bigint, target: LineTarget, token: StakeToken = JITOSOL) {
  const treasuryAccount = treasuryAccountPda();
  return coreIx(
    "redeem_treasury",
    { treasury: treasuryPda(), treasury_account: treasuryAccount, basket: basketPda(treasuryAccount), spill: spillPda(treasuryAccount), position, source },
    { line: lineArg(target.line), amount: gemas },
    [...stakeRateRemaining(token), ...target.accounts.map((k) => meta(k, true))],
  );
}

/** Admin: the staking token new Positions open with (creates its custody and vault the first time). */
export const setStakeTokenIx = (admin: PublicKey, token: StakeToken = JITOSOL) =>
  coreIx("set_stake_token", {
    admin,
    config: CONFIG,
    stake_config: stakeConfigPda(),
    mint: token.mint,
    stake_pool: token.pool,
    custody: stakeCustodyPda(token.mint),
    vault: stakeVaultPda(token.mint),
  });

/** Admin: the ceiling on the annualised growth an Advance is sized on, basis points (1 to 2,000). */
export const setStakeApyCeilingIx = (admin: PublicKey, bps: number) =>
  coreIx("set_stake_apy_ceiling", { admin, config: CONFIG, stake_config: stakeConfigPda() }, { apy_ceiling_bps: bps });

/** Admin: creates the Treasury without a simSOL vault, or changes its rates. */
export const initTreasuryStakeIx = (admin: PublicKey, yieldFeeBps: number, instantFeeBps: number) =>
  coreIx("init_treasury_stake", { admin, config: CONFIG, treasury: treasuryPda(), treasury_account: treasuryAccountPda() }, { yield_fee_bps: yieldFeeBps, instant_fee_bps: instantFeeBps });

/** Admin: pays `units` lamports of value of the Treasury's balance, in the token, to the company wallet's token account. */
export const withdrawTreasuryStakeIx = (admin: PublicKey, company: PublicKey, units: bigint, token: StakeToken = JITOSOL) =>
  coreIx(
    "withdraw_treasury_stake",
    {
      admin,
      config: CONFIG,
      treasury: treasuryPda(),
      custody: stakeCustodyPda(token.mint),
      vault: stakeVaultPda(token.mint),
      company_token: tokenAta(company, token.mint),
      stake_pool: token.pool,
      token_program: TOKEN_PROGRAM_ID,
    },
    { amount: units },
  );

/** Admin: moves the staking token from the admin's token account into the custody vault as the Treasury's balance. */
export const fundTreasuryStakeIx = (admin: PublicKey, shares: bigint, token: StakeToken = JITOSOL) =>
  coreIx(
    "fund_treasury_stake",
    { admin, config: CONFIG, custody: stakeCustodyPda(token.mint), vault: stakeVaultPda(token.mint), admin_token: tokenAta(admin, token.mint), token_program: TOKEN_PROGRAM_ID },
    { shares },
  );

// ---- Readers -------------------------------------------------------------------------------------

/** `StakeCustody`: disc 8, bump, vault_bump, mint, pool, vault, principal, fee_shares, fee_principal, realised_fee_shares (u128), open_positions, refilled, instant, withdrawn (u64), then the Treasury's route. */
export const STAKE_CUSTODY_LEN = 8 + 2 + 3 * 32 + 4 * 16 + 8 + 3 * 8 + ROUTE_LEN;
/** `StakeConfig`: disc 8, bump, active_mint, apy_ceiling_bps u16. */
export const STAKE_CONFIG_LEN = 8 + 1 + 32 + 2;

const rdU128 = (d: Uint8Array, o: number) => rdU64(d, o) + (rdU64(d, o + 8) << 64n);

export interface StakeCustodyView {
  mint: PublicKey;
  pool: PublicKey;
  vault: PublicKey;
  principal: bigint;
  feeShares: bigint;
  feePrincipal: bigint;
  realisedFeeShares: bigint;
  openPositions: bigint;
  refilledShares: bigint;
  instantShares: bigint;
  withdrawnShares: bigint;
  /** The Treasury's shares (tokens) on this route: what it holds, owes and may spend. */
  route: RouteView;
}

export function parseStakeCustody(d: Uint8Array): StakeCustodyView | null {
  if (d.length !== STAKE_CUSTODY_LEN) return null;
  const key = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const o = 8 + 2 + 96;
  return {
    mint: key(10),
    pool: key(42),
    vault: key(74),
    principal: rdU128(d, o),
    feeShares: rdU128(d, o + 16),
    feePrincipal: rdU128(d, o + 32),
    realisedFeeShares: rdU128(d, o + 48),
    openPositions: rdU64(d, o + 64),
    refilledShares: rdU64(d, o + 72),
    instantShares: rdU64(d, o + 80),
    withdrawnShares: rdU64(d, o + 88),
    route: parseRoute(d, o + 96),
  };
}

export function parseStakeConfig(d: Uint8Array): { activeMint: PublicKey; apyCeilingBps: number } | null {
  if (d.length !== STAKE_CONFIG_LEN) return null;
  return { activeMint: new PublicKey(d.subarray(9, 41)), apyCeilingBps: rdU16(d, 41) };
}

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Tokens the vault must keep to return every Locked Position's Principal at `rate` (Rust `principal_reserve`). */
export const principalReserve = (c: Pick<StakeCustodyView, "principal">, rate: bigint) => ceilDiv(c.principal * STAKE_RATE_SCALE, rate);

/** Yield Fee earned by the Treasury at `rate`, in tokens (Rust `StakeTotals::earned_fee_shares`): conservative, never more than the sum of the per-Position fees. */
export function earnedFeeShares(c: StakeCustodyView, rate: bigint): bigint {
  const reserve = ceilDiv(c.feePrincipal * STAKE_RATE_SCALE, rate);
  const pooled = c.feeShares > reserve ? (c.feeShares - reserve) / BPS : 0n;
  const allowance = 3n * c.openPositions;
  return (pooled > allowance ? pooled - allowance : 0n) + c.realisedFeeShares;
}

/** The Treasury's balance in tokens (Rust `StakeCustody::treasury_balance`): its claim, never above the vault's headroom over the Principal reserve. */
export function stakeTreasuryBalance(c: StakeCustodyView, rate: bigint, vaultAmount: bigint): bigint {
  const earned = earnedFeeShares(c, rate) + c.refilledShares;
  const paid = c.instantShares + c.withdrawnShares;
  const claim = earned > paid ? earned - paid : 0n;
  const reserve = principalReserve(c, rate);
  const headroom = vaultAmount > reserve ? vaultAmount - reserve : 0n;
  return claim < headroom ? claim : headroom;
}

/** Tokens `units` lamports are worth at `rate`, rounded down (Rust `tokens_for_units`). */
export const tokensForUnits = (units: bigint, rate: bigint) => (units * STAKE_RATE_SCALE) / rate;
/** Lamports `tokens` are worth at `rate`, rounded down (Rust `units_for_tokens`). */
export const unitsForTokens = (tokens: bigint, rate: bigint) => (tokens * rate) / STAKE_RATE_SCALE;

export interface StakeMarket {
  token: StakeToken;
  /** The mint the program's setting names for new Positions; null before an admin sets one. */
  activeMint: PublicKey | null;
  /** The admin's ceiling on the Advance APY, basis points; 0 while it is not set (no Advance can be taken). */
  ceilingBps: number;
  /** True when the setting names `token` and the ceiling is set: the Wallet can open and advance. */
  open: boolean;
  pool: StakePoolView;
  /** The pool's Staking Rate now, 1e12. */
  rate: bigint;
  /** The APY an Advance would be sized on now, basis points (0 when the pool shows no growth). */
  sizingBps: number;
  /** The wallet's balance of the token, base units. */
  tokenBalance: bigint;
  /** The Treasury's balance in tokens, or null while the custody does not exist. */
  treasuryTokens: bigint | null;
  custody: StakeCustodyView | null;
}

/**
 * The accounts `stakeMarketFrom` reads, in order: stake setting, the token's pool, its custody, the vault, the wallet's token
 * account, the Pyth SOL/USD feed and the Treasury.
 */
export const stakeMarketKeys = (wallet: PublicKey, token: StakeToken = JITOSOL) => [
  stakeConfigPda(),
  token.pool,
  stakeCustodyPda(token.mint),
  stakeVaultPda(token.mint),
  tokenAta(wallet, token.mint),
  solPriceKey(),
  treasuryPda(),
];

type Info = AccountInfo<Buffer> | null;

/** The mainnet market from the accounts of `stakeMarketKeys`. Throws when the token's pool cannot be read. */
export function stakeMarketFrom([config, poolInfo, custodyInfo, vault, ata, feed, treasuryInfo]: Info[], token: StakeToken = JITOSOL): NativeMarket {
  const pool = poolInfo && poolInfo.owner.equals(token.poolProgram) ? parseStakePool(poolInfo.data) : null;
  const rate = pool && stakePoolRate(pool.totalLamports, pool.poolTokenSupply);
  if (!pool || !rate) throw new Error(`${token.symbol} stake pool not readable`);
  const cfg = config && config.owner.equals(TESORO_CORE_ID) ? parseStakeConfig(config.data) : null;
  const activeMint = cfg && !cfg.activeMint.equals(PublicKey.default) ? cfg.activeMint : null;
  const ceilingBps = cfg?.apyCeilingBps ?? 0;
  const custody = custodyInfo && custodyInfo.owner.equals(TESORO_CORE_ID) ? parseStakeCustody(custodyInfo.data) : null;
  const vaultAmount = vault && vault.data.length >= 72 ? rdU64(vault.data, 64) : 0n;
  const treasury = treasuryInfo && treasuryInfo.owner.equals(TESORO_CORE_ID) ? parseTreasury(treasuryInfo.data) : null;
  const sizingBps = sizingApyBps(pool, ceilingBps);
  const tokenBalance = ata && ata.data.length >= 72 ? rdU64(ata.data, 64) : 0n;
  const stake: StakeMarket = {
    token,
    activeMint,
    ceilingBps,
    open: !!activeMint && activeMint.equals(token.mint) && ceilingBps > 0 && !!custody,
    pool,
    rate,
    sizingBps,
    tokenBalance,
    treasuryTokens: custody ? custody.route.spendable : null,
    custody,
  };
  return {
    // The sim_lst pool does not exist here: the fields components still read are the sizing APY and a speedup of one.
    pool: { baseRate: 0n, baseTs: 0, apyBps: sizingBps, speedup: 1 },
    price: parseSolPrice(feed),
    simSol: tokenBalance,
    treasury,
    treasuryShares: null,
    treasuryClaim: null,
    treasuryRoute: custody?.route ?? null,
    stake,
  };
}

export { tokenSymbol };
