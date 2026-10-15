import "./polyfill";
import {
  Connection,
  PublicKey,
  type AccountInfo,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { covered, live, unitsToRepay, type SourceMath } from "./ledger";
import { parseTreasury, parseVaultShares, type TreasuryRates } from "./fees";
import { DEFAULT_YIELD_FEE_BPS, advanceUnits, accruedYield, netOfYieldFee, secondsToAccrue } from "./yield";

/**
 * Solana-native Positions (simSOL custody, tesoro_core) and the SIMULATED sim_lst pool. Instructions
 * are encoded by hand (accounts follow scripts/native-position) so no IDL regeneration is needed.
 * Shared with the keeper: web3.js only, relative imports only. Simulated yield: 1 month = ~10 min.
 */

export const TESORO_CORE_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const SIM_LST_ID = new PublicKey("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const RATE_SCALE = 1_000_000_000n;
export const LAMPORTS = 1_000_000_000;
/** Wall-clock minutes of one simulated month (speedup 4,380 = 1/12 year per 10 minutes, `lib/chain/yield.ts`). */
export const SIM_MONTH_MIN = 10;
/** The feed is only accepted by `take_native_advance` for this long. */
export const MAX_PRICE_AGE_SECS = 24 * 60 * 60;

export const pda = (seeds: (Buffer | Uint8Array)[], program = TESORO_CORE_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const s = (x: string) => Buffer.from(x);
// The browser Buffer polyfill has no bigint accessors: read and write through DataView.
const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
export const rdU64 = (d: Uint8Array, o: number) => view(d).getBigUint64(o, true);
export const rdI64 = (d: Uint8Array, o: number) => view(d).getBigInt64(o, true);
export const rdU32 = (d: Uint8Array, o: number) => view(d).getUint32(o, true);
const rdU16 = (d: Uint8Array, o: number) => view(d).getUint16(o, true);
export const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  view(b).setBigUint64(0, BigInt(n), true);
  return b;
};
/** Anchor discriminators, `sha256("global:<name>")[..8]`, precomputed so the browser needs no hash library. */
const DISC = {
  faucet: "00623b1e908e710c",
  set_price: "1013b608955348b5",
  open_native_position: "b7d9396b6a5048f1",
  take_native_advance: "db4fb2d566baf470",
  extend_native_advance: "d0c7fde715af8ee9",
  accrue_native_yield: "bcef708573f97f3f",
  redeem: "b80c569546c461e1",
  unlock: "659b28159ebd38cb",
  sweep_native_surplus: "01150d37eb622670",
  init_treasury: "6998ad339e97310e",
  fund_treasury: "479a2ddcce20aeef",
  instant_redeem: "bb6bd07de0ed285d",
  redeem_treasury: "109798e01b5bb9cd",
  set_extend_limit: "419bcc697b0524a5",
  open_stake_pool_position: "e58b6d3d23f9cad3",
  accrue_stake_pool_yield: "f4704f80b8f6a423",
  set_token_apy: "34cd6ebb705abe74",
  set_token_apy_ceiling: "040a50fce0d7d95a",
} as const;
const disc = (name: keyof typeof DISC) => Buffer.from(DISC[name], "hex");

export const POOL = pda([s("pool")], SIM_LST_ID);
export const SIM_SOL_MINT = pda([s("mint")], SIM_LST_ID);
export const CONFIG = pda([s("config")]);
export const PRICE_FEED = pda([s("price"), SIM_SOL_MINT.toBuffer()]);

/** tesoro_core `["yield"]` PDA: signs `sim_lst::mint_yield` during `accrue_native_yield`. */
export const yieldAuthorityPda = () => pda([s("yield")]);
/** sim_lst `["yield_config"]`: records the one authority allowed to mint simulated yield. */
export const yieldConfigPda = () => pda([s("yield_config")], SIM_LST_ID);

/** tesoro_core `["treasury"]`: Tesoro's Yield Fee and Instant Redeem rates, and the owner of the Treasury Account and vault. */
export const treasuryPda = () => pda([s("treasury")]);
/** The treasury simSOL token account: collects the Yield Fee, pays Instant Redeems. */
export const treasuryVaultPda = () => pda([s("treasury_vault")]);
export const treasuryAccountPda = () => pda([s("account"), treasuryPda().toBuffer()]);

export const accountPda = (authority: PublicKey) => pda([s("account"), authority.toBuffer()]);
/** Same derivation as `native_position_id` on chain: sha256("native" || owner || nonce_le). */
export async function positionId(owner: PublicKey, nonce: bigint | number): Promise<Buffer> {
  const input = Buffer.concat([s("native"), owner.toBuffer(), u64(nonce)]);
  return Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", input));
}
export async function positionPda(owner: PublicKey, nonce: bigint | number): Promise<PublicKey> {
  return pda([s("position"), Buffer.from([0]), await positionId(owner, nonce)]);
}
export const custodyPda = (position: PublicKey) => pda([s("native"), position.toBuffer()]);
export const vaultPda = (position: PublicKey) => pda([s("native_vault"), position.toBuffer()]);
export const sourcePda = (position: PublicKey, index: number) => {
  const i = Buffer.alloc(4);
  view(i).setUint32(0, index, true);
  return pda([s("source"), position.toBuffer(), i]);
};
export const holdingPda = (account: PublicKey, source: PublicKey) => pda([s("holding"), account.toBuffer(), source.toBuffer()]);
export const simSolAta = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), SIM_SOL_MINT.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

/** The owner's associated token account of `mint`. */
export const ataOf = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

/**
 * What a payout of a custody holding a real staking token needs beyond the simSOL defaults: the token, the stake pool that
 * values it and the Treasury's vault of that token. Absent (undefined) means a simSOL custody.
 */
export interface TokenCustody {
  mint: PublicKey;
  pool: PublicKey;
  treasuryVault: PublicKey;
}

export const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });
export const core = (keys: AccountMeta[], name: keyof typeof DISC, ...args: Buffer[]) =>
  new TransactionInstruction({ programId: TESORO_CORE_ID, keys, data: Buffer.concat([disc(name), ...args]) });

// --- Instructions ------------------------------------------------------------------------------

/** Creates the owner's simSOL token account if missing (fee payer = owner). */
export const createSimSolAtaIx = (payer: PublicKey, owner: PublicKey) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      meta(payer, true, true),
      meta(simSolAta(owner), true),
      meta(owner),
      meta(SIM_SOL_MINT),
      meta(SystemProgram.programId),
      meta(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });

/** SIMULATED faucet: mints simSOL (unbacked) to the user, once per cooldown. */
export function faucetIx(user: PublicKey) {
  return new TransactionInstruction({
    programId: SIM_LST_ID,
    keys: [
      meta(user, true, true),
      meta(POOL),
      meta(SIM_SOL_MINT, true),
      meta(simSolAta(user), true),
      meta(pda([s("faucet"), user.toBuffer()], SIM_LST_ID), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: disc("faucet"),
  });
}

/** Oracle authority publishes SOL/USD (micro-USD per SOL). Devnet stand-in for Pyth. */
export const setPriceIx = (oracle: PublicKey, priceMicroUsd: bigint) =>
  core([meta(oracle, true, true), meta(CONFIG), meta(PRICE_FEED, true), meta(SystemProgram.programId)], "set_price", u64(priceMicroUsd));

/** `position` is `await positionPda(owner, nonce)`. */
export function openNativePositionIx(owner: PublicKey, nonce: bigint | number, lstAmount: bigint, position: PublicKey) {
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner)),
      meta(POOL),
      meta(SIM_SOL_MINT),
      meta(simSolAta(owner), true),
      meta(position, true),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "open_native_position",
    u64(nonce),
    u64(lstAmount),
  );
}

/** `["token_apy", mint]`: a real staking token's published APY and ceiling. */
export const tokenApyPda = (mint: PublicKey) => pda([s("token_apy"), mint.toBuffer()]);

/**
 * `advances` is the Position's advance count before this one (0 for a new Position). `mint` is the Position's
 * token: its price feed sizes the Advance (the simSOL feed by default). A real token also passes its `TokenApy`, which
 * the program re-reads (the lower of the published APY and the ceiling) and requires fresh.
 */
export function takeNativeAdvanceIx(owner: PublicKey, position: PublicKey, advances: number, months: number, mint?: PublicKey) {
  const source = sourcePda(position, advances);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(position, true),
      meta(mint ? pda([s("price"), mint.toBuffer()]) : PRICE_FEED),
      meta(treasuryPda()),
      meta(source, true),
      meta(holdingPda(accountPda(owner), source), true),
      meta(SystemProgram.programId),
      ...(mint ? [meta(tokenApyPda(mint))] : []),
    ],
    "take_native_advance",
    Buffer.from([months]),
  );
}

export const extendLimitPda = (account: PublicKey) => pda([s("extend_limit"), account.toBuffer()]);

/** `info.source.index` is the Position's open Advance; the owner signs alone and `extraMonths` is added to its Horizon (1 to 12 minus the Horizon so far). The owner pays for their Extend Limit account on the first Extend (ADR 0009). */
export function extendNativeAdvanceIx(owner: PublicKey, position: PublicKey, source: number, extraMonths: number, mint?: PublicKey) {
  const src = sourcePda(position, source);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(position, true),
      meta(treasuryPda()),
      meta(src, true),
      meta(holdingPda(accountPda(owner), src), true),
      meta(extendLimitPda(accountPda(owner)), true),
      meta(SystemProgram.programId),
      ...(mint ? [meta(tokenApyPda(mint))] : []),
    ],
    "extend_native_advance",
    Buffer.from([extraMonths]),
  );
}

/** Sets the owner's Extend Limit (0 to 11 months): a lower limit applies at once, a higher one 24 hours later. */
export const setExtendLimitIx = (owner: PublicKey, months: number) =>
  core(
    [meta(owner, true, true), meta(accountPda(owner)), meta(extendLimitPda(accountPda(owner)), true), meta(SystemProgram.programId)],
    "set_extend_limit",
    Buffer.from([months]),
  );

/** Permissionless; mints the Yield Fee into the treasury vault. `openAdvance` is the Position's open Advance index, if any (the optional account). */
export const accrueNativeYieldIx = (position: PublicKey, openAdvance: number | null) =>
  core(
    [
      meta(position, true),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(POOL),
      meta(SIM_SOL_MINT, true),
      meta(yieldConfigPda()),
      meta(yieldAuthorityPda()),
      meta(SIM_LST_ID),
      meta(TOKEN_PROGRAM_ID),
      meta(treasuryPda(), true),
      meta(treasuryVaultPda(), true),
      // Optional account: the program id stands for `None`.
      meta(openAdvance === null ? TESORO_CORE_ID : sourcePda(position, openAdvance), openAdvance !== null),
    ],
    "accrue_native_yield",
  );

/** The holder's token account for payouts: simSOL by default. */
const payoutAta = (holder: PublicKey, tok?: TokenCustody) => (tok ? ataOf(holder, tok.mint) : simSolAta(holder));

/**
 * `[custody, vault, destination, pool, token_program]`, plus `[treasury, treasury_vault]` when `settleFee` and the custody is a
 * stake pool one (Unlock and sweep let the vault's surplus leave, so the Yield Fee on the rate's growth is settled first).
 */
const payoutRemaining = (position: PublicKey, dest: PublicKey, tok?: TokenCustody, settleFee = false): AccountMeta[] => [
  meta(custodyPda(position), true),
  meta(vaultPda(position), true),
  meta(dest, true),
  meta(tok ? tok.pool : POOL),
  meta(TOKEN_PROGRAM_ID),
  ...(tok && settleFee ? [meta(treasuryPda(), true), meta(tok.treasuryVault, true)] : []),
];

/** Redeem Gemas of `source`: the holder is paid simSOL into their own token account. */
export function redeemIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint, tok?: TokenCustody) {
  const account = accountPda(holder);
  const i = core(
    [meta(holder, false, true), meta(account, true), meta(position), meta(source, true), meta(holdingPda(account, source), true)],
    "redeem",
    u64(gemas),
  );
  i.keys.push(...payoutRemaining(position, payoutAta(holder, tok), tok));
  return i;
}

/**
 * Instant Redeem: the holder sells won Gemas of a native Source and the treasury vault pays simSOL into
 * their token account in the same transaction (fails when the vault holds less).
 */
export function instantRedeemIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint, tok?: TokenCustody) {
  const account = accountPda(holder);
  const treasuryAccount = treasuryAccountPda();
  return core(
    [
      meta(holder, true, true),
      meta(account, true),
      meta(position),
      meta(source),
      meta(holdingPda(account, source), true),
      meta(treasuryPda(), true),
      meta(treasuryAccount, true),
      meta(holdingPda(treasuryAccount, source), true),
      meta(tok ? tok.treasuryVault : treasuryVaultPda(), true),
      meta(payoutAta(holder, tok), true),
      meta(tok ? tok.pool : POOL),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "instant_redeem",
    u64(gemas),
  );
}

/** Permissionless: the Treasury Account redeems Gemas it bought; the simSOL goes into the treasury vault. */
export function redeemTreasuryIx(position: PublicKey, source: PublicKey, gemas: bigint, tok?: TokenCustody) {
  const treasuryAccount = treasuryAccountPda();
  const i = core(
    [meta(treasuryPda()), meta(treasuryAccount, true), meta(position), meta(source, true), meta(holdingPda(treasuryAccount, source), true)],
    "redeem_treasury",
    u64(gemas),
  );
  i.keys.push(...payoutRemaining(position, tok ? tok.treasuryVault : treasuryVaultPda(), tok));
  return i;
}

/** Admin: creates the Treasury or changes its rates (basis points of yield / of the Gemas' value). */
export const initTreasuryIx = (admin: PublicKey, yieldFeeBps: number, instantFeeBps: number) => {
  const bps = Buffer.alloc(4);
  view(bps).setUint16(0, yieldFeeBps, true);
  view(bps).setUint16(2, instantFeeBps, true);
  return core(
    [
      meta(admin, true, true),
      meta(CONFIG),
      meta(treasuryPda(), true),
      meta(treasuryAccountPda(), true),
      meta(SIM_SOL_MINT),
      meta(treasuryVaultPda(), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "init_treasury",
    bps,
  );
};

/** Admin: moves simSOL from the admin's token account into the treasury vault. */
export const fundTreasuryIx = (admin: PublicKey, shares: bigint) =>
  core(
    [meta(admin, false, true), meta(CONFIG), meta(treasuryPda(), true), meta(treasuryVaultPda(), true), meta(simSolAta(admin), true), meta(TOKEN_PROGRAM_ID)],
    "fund_treasury",
    u64(shares),
  );

/** Debt must be zero on chain (send `accrueNativeYieldIx` first). Returns the Principal shares to the owner. */
export function unlockIx(owner: PublicKey, position: PublicKey, tok?: TokenCustody) {
  const i = core([meta(owner, false, true), meta(accountPda(owner)), meta(position, true)], "unlock");
  i.keys.push(...payoutRemaining(position, payoutAta(owner, tok), tok, true));
  return i;
}

export const sweepNativeSurplusIx = (owner: PublicKey, position: PublicKey, tok?: TokenCustody) => {
  const i = core(
    [
      meta(owner, false, true),
      meta(accountPda(owner)),
      meta(position),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(payoutAta(owner, tok), true),
      meta(tok ? tok.pool : POOL),
      meta(TOKEN_PROGRAM_ID),
    ],
    "sweep_native_surplus",
  );
  if (tok) i.keys.push(meta(treasuryPda(), true), meta(tok.treasuryVault, true));
  return i;
};

// --- Pure math ---------------------------------------------------------------------------------

export interface PoolParams {
  baseRate: bigint;
  baseTs: number;
  apyBps: number;
  speedup: number;
}

/** sim_lst rate (SOL per simSOL, 1e9 fixed point): constant since the per-Position yield model (docs/yield-model.md). */
export function rateAt(p: PoolParams): bigint {
  return p.baseRate;
}

/** What a custody needs to project the yield `accrue_native_yield` has not minted yet. */
export interface YieldClock {
  rateBps: number;
  /** Unix seconds up to which yield is minted into the vault. */
  lastAccrualTs: number;
  /** A real staking token: its yield is the pool rate's growth, already in the pool's rate, so nothing is projected on top; the rate only times the Unlock Estimate. */
  realized?: boolean;
}

/** The yield clock of a Locked, migrated custody; null when nothing more will be minted. A stake pool custody always has one (its rate is the Position's recorded APY). */
export const yieldClockOf = (info: Pick<NativeInfo, "status" | "rateBps" | "lastAccrualTs"> & { stakePool?: boolean }): YieldClock | null => {
  if (info.status !== "locked") return null;
  if (info.stakePool) return { rateBps: info.rateBps, lastAccrualTs: info.lastAccrualTs ?? 0, realized: true };
  return info.lastAccrualTs !== null ? { rateBps: info.rateBps, lastAccrualTs: info.lastAccrualTs } : null;
};

/** Cumulative accrued yield (SOL units, net of the Yield Fee) as the program would read it after a crank at `nowMs`. */
export function accruedAt(args: { vaultShares: bigint; redeemedUnits: bigint; principalLamports: bigint; pool: PoolParams; clock?: YieldClock | null; nowMs: number; yieldFeeBps?: number }): bigint {
  const { vaultShares, redeemedUnits, principalLamports, pool, clock, nowMs } = args;
  const minted = sharesValue(vaultShares, rateAt(pool)) + redeemedUnits - principalLamports;
  const pending = clock && !clock.realized
    ? netOfYieldFee(
        accruedYield({
          principal: principalLamports,
          rateBps: clock.rateBps,
          elapsedSec: BigInt(Math.max(0, Math.floor(nowMs / 1000) - clock.lastAccrualTs)),
          speedup: BigInt(pool.speedup),
        }),
        args.yieldFeeBps ?? DEFAULT_YIELD_FEE_BPS,
      )
    : 0n;
  return (minted > 0n ? minted : 0n) + pending;
}

/** SOL base units a simSOL amount is worth at `rate`. */
export const sharesValue = (shares: bigint, rate: bigint) => (shares * rate) / RATE_SCALE;

/** Advance sizing exactly as `Position::open_advance`: the projected yield net of the Yield Fee, floored to whole Gemas. */
export function quoteNativeAdvance(principalLamports: bigint, rateBps: number, months: number, priceMicroUsd: bigint, yieldFeeBps = DEFAULT_YIELD_FEE_BPS) {
  const projectedUnits = advanceUnits(principalLamports, rateBps, months, yieldFeeBps);
  const gemas = (projectedUnits * priceMicroUsd) / 10n ** 13n;
  return { projectedUnits, gemas };
}

/**
 * Extending an Advance by `extraMonths`, as `Position::extend_advance`: the Gemas minted are
 * `size(h + extra) - size(h)` at the Source's own price and the current Yield Fee, so a fee change since the Advance never skews the quote.
 */
export function quoteExtendAdvance(principalLamports: bigint, rateBps: number, source: SourceMath, horizonMonths: number, extraMonths: number, yieldFeeBps = DEFAULT_YIELD_FEE_BPS) {
  const size = (months: number) => (advanceUnits(principalLamports, rateBps, months, yieldFeeBps) * source.unitDen) / source.unitNum;
  const gemas = size(horizonMonths + extraMonths) - size(horizonMonths);
  return { gemas, extended: { ...source, issued: source.issued + gemas } };
}

/**
 * Unlock Estimate (ms since epoch): when the Position's accrued yield covers the Source's Debt at
 * its own linear rate. Null when it cannot be projected (nothing earning). An estimate, never a
 * promise: it moves with the pool's yield parameters.
 */
export function unlockEstimateMs(args: {
  source: SourceMath | null;
  vaultShares: bigint;
  redeemedUnits: bigint;
  principalLamports: bigint;
  pool: PoolParams;
  clock: YieldClock;
  nowMs: number;
  yieldFeeBps?: number;
}): number | null {
  const { source, vaultShares, redeemedUnits, principalLamports, pool, clock, nowMs, yieldFeeBps } = args;
  if (!source) return null;
  const needed = unitsToRepay(source) + source.yieldUnits; // total yield units that repay every live Gema
  const accrued = accruedAt({ vaultShares, redeemedUnits, principalLamports, pool, clock, nowMs, yieldFeeBps });
  const have = accrued > source.yieldUnits ? accrued : source.yieldUnits;
  if (have >= needed) return nowMs;
  const secs = secondsToAccrue({ principal: principalLamports, rateBps: clock.rateBps, units: needed - have, speedup: BigInt(pool.speedup), yieldFeeBps });
  return secs === null ? null : nowMs + secs * 1000;
}

/** Debt in Gemas if the Position's yield were applied now (what a crank would leave). */
export function projectedDebtGemas(source: SourceMath | null, vaultShares: bigint, redeemedUnits: bigint, principalLamports: bigint, pool: PoolParams, nowMs: number, clock: YieldClock | null = null, yieldFeeBps?: number): bigint {
  if (!source) return 0n;
  const accrued = accruedAt({ vaultShares, redeemedUnits, principalLamports, pool, clock, nowMs, yieldFeeBps });
  const y = accrued > source.yieldUnits ? accrued : source.yieldUnits;
  const l = live(source);
  const c = covered({ ...source, yieldUnits: y });
  return l - c;
}

/** simSOL base units that redeeming `gemas` of a Source pays now (floor, as the program computes it). */
export function redeemPayoutShares(source: Pick<SourceMath, "unitNum" | "unitDen">, gemas: bigint, rate: bigint): bigint {
  const units = (gemas * source.unitNum) / source.unitDen;
  return (units * RATE_SCALE) / rate;
}

/**
 * simSOL base units an Unlocked Position's owner can sweep: the vault beyond the yield still owed to
 * holders (tesoro_core `surplus_shares`, owed rounded up). 0 while Locked.
 */
export function surplusShares(info: Pick<NativeInfo, "status" | "vaultShares" | "cumulativeYield" | "freeYield" | "redeemedUnits">, rate: bigint): bigint {
  if (info.status !== "unlocked" || rate <= 0n) return 0n;
  const owed = info.cumulativeYield - info.freeYield - info.redeemedUnits;
  const required = owed > 0n ? (owed * RATE_SCALE + rate - 1n) / rate : 0n;
  return info.vaultShares > required ? info.vaultShares - required : 0n;
}

// --- Readers -----------------------------------------------------------------------------------

export interface PriceFeedView {
  microUsd: bigint;
  updatedTs: number;
}

export interface NativeMarket {
  pool: PoolParams;
  /** Null until the oracle has published a price. */
  price: PriceFeedView | null;
  /** The wallet's simSOL balance, base units. */
  simSol: bigint;
  /** Yield Fee and Instant Redeem Fee rates; null until `init_treasury` has run (use `ratesOf` for the launch rates). */
  treasury: TreasuryRates | null;
  /** simSOL the treasury vault holds to pay Instant Redeems; null while there is no Treasury. */
  treasuryShares: bigint | null;
  /** Set on a cluster with a real staking token (`pool` then holds the stake pool's rate and the token's trailing APY, speedup 1; `simSol` the wallet's balance of the token). */
  token?: TokenCustody & { symbol: string };
}

/**
 * The APY an Advance or Extend on `info` is sized on. A simSOL Position keeps the rate it opened with; a real staking
 * token follows the program, which re-reads `min(published, ceiling)` at each Advance and Extend, so the market's APY
 * applies (0 while the published APY is stale or no ceiling is set: nothing can be sized).
 */
export const sizingRateBps = (info: Pick<NativeInfo, "rateBps">, market: NativeMarket | null): number => (market?.token ? market.pool.apyBps : info.rateBps);

export interface NativeInfo {
  position: PublicKey;
  custody: PublicKey;
  /** The token the custody holds and the account that values it (the sim_lst Pool, or a stake pool). */
  mint: PublicKey;
  pool: PublicKey;
  /** The custody is valued by an SPL stake pool (a real staking token): yield is the pool rate's growth, Unlock and sweep settle the Yield Fee. */
  stakePool: boolean;
  status: "locked" | "unlocked";
  principalLamports: bigint;
  rateBps: number;
  advances: number;
  openAdvance: number | null;
  cumulativeYield: bigint;
  freeYield: bigint;
  vaultShares: bigint;
  redeemedUnits: bigint;
  /** Unix seconds up to which yield is minted into the vault (null on a custody not yet migrated). */
  lastAccrualTs: number | null;
  /** The latest Advance's Source (kept after Debt reaches zero), null before the first Advance. */
  source: { key: PublicKey; index: number; horizonMonths: number; math: SourceMath } | null;
}

/** Test mode (sim_lst). On a cluster with a real staking token use `fetchMarket` (stake-market.ts). The accounts `marketFrom` reads, in order: pool, price feed, the wallet's simSOL token account, Treasury, Treasury vault. */
export const marketKeys = (wallet: PublicKey) => [POOL, PRICE_FEED, simSolAta(wallet), treasuryPda(), treasuryVaultPda()];

export async function fetchNativeMarket(c: Connection, wallet: PublicKey): Promise<NativeMarket> {
  return marketFrom(await c.getMultipleAccountsInfo(marketKeys(wallet), "confirmed"));
}

/** The market from the accounts of `marketKeys`, already read. Throws when the pool does not exist. */
export function marketFrom([pool, feed, ata, treasuryInfo, treasuryVault]: (AccountInfo<Buffer> | null)[]): NativeMarket {
  if (!pool) throw new Error("sim_lst pool not initialized");
  const d = Buffer.from(pool.data);
  let simSol = 0n;
  if (ata) simSol = rdU64(ata.data, 64);
  let price: PriceFeedView | null = null;
  if (feed && feed.owner.equals(TESORO_CORE_ID)) {
    const f = Buffer.from(feed.data);
    // disc 8, bump 1, asset 32, price u64, updated_ts i64
    price = { microUsd: rdU64(f, 41), updatedTs: Number(rdI64(f, 49)) };
  }
  const treasury = treasuryInfo && treasuryInfo.owner.equals(TESORO_CORE_ID) ? parseTreasury(treasuryInfo.data) : null;
  return {
    pool: { baseRate: rdU64(d, 72), baseTs: Number(rdI64(d, 80)), apyBps: rdU32(d, 88), speedup: rdU32(d, 92) },
    price,
    simSol,
    treasury,
    treasuryShares: treasury ? (treasuryVault && parseVaultShares(treasuryVault.data)) ?? 0n : null,
  };
}

export function parseSource(key: PublicKey, data: Buffer) {
  let o = 8 + 1 + 32 + 32; // disc, bump, position, owner
  const index = rdU32(data, o);
  const horizonMonths = data[o + 4];
  o += 5;
  const unitNum = rdU64(data, o) + (rdU64(data, o + 8) << 64n);
  const unitDen = rdU64(data, o + 16);
  o += 24;
  const math: SourceMath = {
    issued: rdU64(data, o),
    returned: rdU64(data, o + 8),
    redeemed: rdU64(data, o + 16),
    yieldUnits: rdU64(data, o + 24),
    unitNum,
    unitDen,
  };
  return { key, index, horizonMonths, math };
}

/** Reads a native Position with its custody, vault and latest Source. Null when it is not a native Position. */
export async function fetchNativeInfo(c: Connection, position: PublicKey): Promise<NativeInfo | null> {
  const custody = custodyPda(position);
  const [pos, cust, vault] = await c.getMultipleAccountsInfo([position, custody, vaultPda(position)], "confirmed");
  if (!pos || !cust || !vault) return null;
  const advances = rdU32(Buffer.from(pos.data), NATIVE_ADVANCES_AT);
  const src = advances > 0 ? await c.getAccountInfo(sourcePda(position, advances - 1), "confirmed") : null;
  return nativeInfoFrom(position, pos, cust, vault, src);
}

/** `NativeCustody::SPACE` and the trailing stake pool marker (tesoro_core state.rs): a custody valued by a stake pool is allocated past `SPACE` with marker 2 and the last rate the fee was settled at. */
const CUSTODY_SPACE = 8 + 2 + 5 * 32 + 5 * 8;
const STAKE_POOL_SPACE = CUSTODY_SPACE + 1 + 8;
const STAKE_POOL_MARKER = 2;

/** Byte offset of `advances` in a PositionState: disc, bump, id, owner, chain, asset, decimals, principal, rate, status. */
const NATIVE_ADVANCES_AT = 8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1;

/** `fetchNativeInfo` from accounts already read; `src` is the latest Source (index `advances - 1`), null when there is none. */
export function nativeInfoFrom(
  position: PublicKey,
  pos: AccountInfo<Buffer>,
  cust: AccountInfo<Buffer>,
  vault: AccountInfo<Buffer>,
  src: AccountInfo<Buffer> | null,
): NativeInfo {
  const custody = custodyPda(position);
  const d = Buffer.from(pos.data);
  let o = 8 + 1 + 32 + 32 + 1 + 32 + 1; // disc, bump, id, owner, chain, asset, decimals
  const principalLamports = rdU64(d, o);
  const rateBps = rdU16(d, o + 8);
  o += 10;
  const status = d[o] === 0 ? "locked" : "unlocked";
  o += 1;
  const advances = rdU32(d, o);
  o += 4;
  const openAdvance = d[o] === 1 ? rdU32(d, o + 1) : null;
  o += (d[o] === 1 ? 5 : 1) + 8; // open_advance (Option<u32>), last_seq
  const cumulativeYield = rdU64(d, o);
  const freeYield = rdU64(d, o + 8);
  // NativeCustody: disc 8, bump, vault_bump, 5 keys (position, owner, pool, mint, vault), rate_at_open, deposited, redeemed
  const redeemedUnits = rdU64(cust.data, 8 + 2 + 5 * 32 + 16);
  const key = (at: number) => new PublicKey(cust.data.subarray(at, at + 32));
  const stakePool = cust.data.length >= STAKE_POOL_SPACE && cust.data[CUSTODY_SPACE] === STAKE_POOL_MARKER;
  // Since F-05 the program reads yield from `tracked_shares` (after redeemed_units), never from the vault's token balance:
  // simSOL sent straight to the vault is not yield. Mirror that, or a top-up shows a Debt that is not really repaid.
  const TRACKED_AT = 8 + 2 + 5 * 32 + 24;
  const tracked = cust.data.length >= TRACKED_AT + 8 ? rdU64(cust.data, TRACKED_AT) : null;
  const ACCRUAL_AT = TRACKED_AT + 8;
  const lastAccrualTs = cust.data.length >= ACCRUAL_AT + 8 ? Number(rdI64(cust.data, ACCRUAL_AT)) : null;
  const vaultBalance = rdU64(vault.data, 64);
  const source: NativeInfo["source"] = advances > 0 && src ? parseSource(sourcePda(position, advances - 1), Buffer.from(src.data)) : null;
  return {
    position,
    custody,
    pool: key(8 + 2 + 2 * 32),
    mint: key(8 + 2 + 3 * 32),
    stakePool,
    status,
    principalLamports,
    rateBps,
    advances,
    openAdvance,
    cumulativeYield,
    freeYield,
    vaultShares: tracked !== null && tracked < vaultBalance ? tracked : vaultBalance,
    redeemedUnits,
    lastAccrualTs,
    source,
  };
}
