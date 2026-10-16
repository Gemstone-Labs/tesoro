import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type AccountMeta } from "@solana/web3.js";
import { parseTreasury } from "./fees";
import {
  CONFIG,
  TESORO_CORE_ID,
  TOKEN_PROGRAM_ID,
  accountPda,
  extendLimitPda,
  holdingPda,
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

/** Anchor discriminators, `sha256("global:<name>")[..8]`. */
const DISC = {
  set_stake_token: "12655d763754c7ab",
  set_stake_apy_ceiling: "625b89312ef07862",
  open_stake_position: "642e20f8001d7a15",
  take_stake_advance: "cd15f5d25ce96bab",
  extend_stake_advance: "999277475292cb65",
  instant_redeem_stake: "af08013ca3ba9771",
  withdraw_treasury_stake: "37f35378bae00045",
  init_treasury_stake: "e8d81b9bc90727e5",
  redeem: "b80c569546c461e1",
  unlock: "659b28159ebd38cb",
  redeem_treasury: "109798e01b5bb9cd",
} as const;
const core = (keys: AccountMeta[], name: keyof typeof DISC, ...args: Buffer[]) =>
  new TransactionInstruction({ programId: TESORO_CORE_ID, keys, data: Buffer.concat([Buffer.from(DISC[name], "hex"), ...args]) });

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
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner)),
      meta(stakeConfigPda()),
      meta(token.mint),
      meta(stakeCustodyPda(token.mint), true),
      meta(stakeVaultPda(token.mint), true),
      meta(tokenAta(owner, token.mint), true),
      meta(token.pool),
      meta(treasuryPda()),
      meta(position, true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "open_stake_position",
    u64(nonce),
    u64(shares),
  );
}

/** An Advance on a staking-token Position: priced from the token's Pyth mapping, sized on the pool's last-epoch growth. `openAdvance` is the open Advance, closed here. */
export function takeStakeAdvanceIx(owner: PublicKey, position: PublicKey, advances: number, months: number, openAdvance: number | null = null, token: StakeToken = JITOSOL) {
  const source = sourcePda(position, advances);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(protectionsPda(accountPda(owner))),
      meta(position, true),
      meta(onchainPricePda(token.mint)),
      meta(pythFeedAddress("SOL")),
      meta(stakeConfigPda()),
      meta(stakeCustodyPda(token.mint)),
      meta(token.pool),
      // Optional account: the program id stands for `None`.
      meta(openAdvance === null ? TESORO_CORE_ID : sourcePda(position, openAdvance), openAdvance !== null),
      meta(source, true),
      meta(holdingPda(accountPda(owner), source), true),
      meta(SystemProgram.programId),
    ],
    "take_stake_advance",
    Buffer.from([months]),
  );
}

export function extendStakeAdvanceIx(owner: PublicKey, position: PublicKey, source: number, extraMonths: number, token: StakeToken = JITOSOL) {
  const src = sourcePda(position, source);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(protectionsPda(accountPda(owner))),
      meta(position, true),
      meta(stakeConfigPda()),
      meta(stakeCustodyPda(token.mint)),
      meta(token.pool),
      meta(src, true),
      meta(holdingPda(accountPda(owner), src), true),
      meta(extendLimitPda(accountPda(owner)), true),
      meta(SystemProgram.programId),
    ],
    "extend_stake_advance",
    Buffer.from([extraMonths]),
  );
}

/** The accounts a stake Position's `return_own` and `redeem_treasury` add after their own: the custody and the pool. */
export const stakeRateRemaining = (token: StakeToken = JITOSOL): AccountMeta[] => [meta(stakeCustodyPda(token.mint), true), meta(token.pool)];

/** Redeem Gemas of a stake Source: the holder is paid the staking token into their own token account. */
export function redeemStakeIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint, token: StakeToken = JITOSOL) {
  const account = accountPda(holder);
  const i = core([meta(holder, false, true), meta(account, true), meta(position), meta(source, true), meta(holdingPda(account, source), true)], "redeem", u64(gemas));
  i.keys.push(...stakeRateRemaining(token), meta(stakeVaultPda(token.mint), true), meta(tokenAta(holder, token.mint), true), meta(TOKEN_PROGRAM_ID));
  return i;
}

/** Unlock: Debt is computed by the program and must be zero; Principal and the free yield return in the token. `openAdvance` is the open Advance, closed here. */
export function unlockStakeIx(owner: PublicKey, position: PublicKey, openAdvance: number | null = null, token: StakeToken = JITOSOL) {
  const i = core([meta(owner, false, true), meta(accountPda(owner)), meta(position, true)], "unlock");
  i.keys.push(...stakeRateRemaining(token), meta(stakeVaultPda(token.mint), true), meta(tokenAta(owner, token.mint), true), meta(TOKEN_PROGRAM_ID));
  if (openAdvance !== null) i.keys.push(meta(sourcePda(position, openAdvance), true));
  return i;
}

/** Instant Redeem of won Gemas of a stake Source: the Treasury's token balance pays the holder in the same transaction. */
export function instantRedeemStakeIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint, token: StakeToken = JITOSOL) {
  const account = accountPda(holder);
  const treasuryAccount = treasuryAccountPda();
  return core(
    [
      meta(holder, true, true),
      meta(account, true),
      meta(position),
      meta(source),
      meta(holdingPda(account, source), true),
      meta(treasuryPda()),
      meta(treasuryAccount, true),
      meta(holdingPda(treasuryAccount, source), true),
      meta(stakeCustodyPda(token.mint), true),
      meta(stakeVaultPda(token.mint), true),
      meta(tokenAta(holder, token.mint), true),
      meta(token.pool),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "instant_redeem_stake",
    u64(gemas),
  );
}

/** Permissionless: the Treasury Account redeems Gemas it bought; the value stays in the vault and joins the Treasury's balance. */
export function redeemTreasuryStakeIx(position: PublicKey, source: PublicKey, gemas: bigint, token: StakeToken = JITOSOL) {
  const treasuryAccount = treasuryAccountPda();
  const i = core([meta(treasuryPda()), meta(treasuryAccount, true), meta(position), meta(source, true), meta(holdingPda(treasuryAccount, source), true)], "redeem_treasury", u64(gemas));
  i.keys.push(...stakeRateRemaining(token));
  return i;
}

/** Admin: the staking token new Positions open with (creates its custody and vault the first time). */
export const setStakeTokenIx = (admin: PublicKey, token: StakeToken = JITOSOL) =>
  core(
    [
      meta(admin, true, true),
      meta(CONFIG),
      meta(stakeConfigPda(), true),
      meta(token.mint),
      meta(token.pool),
      meta(stakeCustodyPda(token.mint), true),
      meta(stakeVaultPda(token.mint), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "set_stake_token",
  );

/** Admin: the ceiling on the annualised growth an Advance is sized on, basis points (1 to 2,000). */
export const setStakeApyCeilingIx = (admin: PublicKey, bps: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(bps);
  return core([meta(admin, true, true), meta(CONFIG), meta(stakeConfigPda(), true), meta(SystemProgram.programId)], "set_stake_apy_ceiling", b);
};

/** Admin: creates the Treasury without a simSOL vault, or changes its rates. */
export const initTreasuryStakeIx = (admin: PublicKey, yieldFeeBps: number, instantFeeBps: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(yieldFeeBps, 0);
  b.writeUInt16LE(instantFeeBps, 2);
  return core([meta(admin, true, true), meta(CONFIG), meta(treasuryPda(), true), meta(treasuryAccountPda(), true), meta(SystemProgram.programId)], "init_treasury_stake", b);
};

/** Admin: pays `units` lamports of value of the Treasury's balance, in the token, to the company wallet's token account. */
export const withdrawTreasuryStakeIx = (admin: PublicKey, company: PublicKey, units: bigint, token: StakeToken = JITOSOL) =>
  core(
    [
      meta(admin, false, true),
      meta(CONFIG),
      meta(treasuryPda(), true),
      meta(stakeCustodyPda(token.mint), true),
      meta(stakeVaultPda(token.mint), true),
      meta(tokenAta(company, token.mint), true),
      meta(token.pool),
      meta(TOKEN_PROGRAM_ID),
    ],
    "withdraw_treasury_stake",
    u64(units),
  );

// ---- Readers -------------------------------------------------------------------------------------

/** `StakeCustody`: disc 8, bump, vault_bump, mint, pool, vault, principal, fee_shares, fee_principal, realised_fee_shares (u128), open_positions, refilled, instant, withdrawn (u64). */
export const STAKE_CUSTODY_LEN = 8 + 2 + 3 * 32 + 4 * 16 + 8 + 3 * 8;
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
    treasuryTokens: custody ? stakeTreasuryBalance(custody, rate, vaultAmount) : null,
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
    stake,
  };
}

export { tokenSymbol };
