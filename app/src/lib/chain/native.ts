import "./polyfill";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { covered, live, unitsToRepay, type SourceMath } from "./ledger";

/**
 * Solana-native Positions (simSOL custody, tesoro_core) and the SIMULATED sim_lst pool. Instructions
 * are encoded by hand (accounts follow scripts/native-position) so no IDL regeneration is needed.
 * Shared with the keeper: web3.js only, relative imports only. Simulated yield: 1 month = ~10 min.
 */

export const TESORO_CORE_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const SIM_LST_ID = new PublicKey("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const YEAR = 31_536_000;
export const RATE_SCALE = 1_000_000_000n;
export const LAMPORTS = 1_000_000_000;
/** Wall-clock minutes of one simulated month (sim_lst speedup 4,320). */
export const SIM_MONTH_MIN = 10;
/** The feed is only accepted by `take_native_advance` for this long. */
export const MAX_PRICE_AGE_SECS = 24 * 60 * 60;

export const pda = (seeds: (Buffer | Uint8Array)[], program = TESORO_CORE_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const s = (x: string) => Buffer.from(x);
// The browser Buffer polyfill has no bigint accessors: read and write through DataView.
const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
export const rdU64 = (d: Uint8Array, o: number) => view(d).getBigUint64(o, true);
const rdI64 = (d: Uint8Array, o: number) => view(d).getBigInt64(o, true);
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
  accrue_native_yield: "bcef708573f97f3f",
  redeem: "b80c569546c461e1",
  unlock: "659b28159ebd38cb",
  sweep_native_surplus: "01150d37eb622670",
} as const;
const disc = (name: keyof typeof DISC) => Buffer.from(DISC[name], "hex");

export const POOL = pda([s("pool")], SIM_LST_ID);
export const SIM_SOL_MINT = pda([s("mint")], SIM_LST_ID);
export const CONFIG = pda([s("config")]);
export const PRICE_FEED = pda([s("price"), SIM_SOL_MINT.toBuffer()]);

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

export const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });
const core = (keys: AccountMeta[], name: keyof typeof DISC, ...args: Buffer[]) =>
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

/** `advances` is the Position's advance count before this one (0 for a new Position). */
export function takeNativeAdvanceIx(owner: PublicKey, position: PublicKey, advances: number, months: number) {
  const source = sourcePda(position, advances);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(position, true),
      meta(PRICE_FEED),
      meta(source, true),
      meta(holdingPda(accountPda(owner), source), true),
      meta(SystemProgram.programId),
    ],
    "take_native_advance",
    Buffer.from([months]),
  );
}

/** Permissionless. `openAdvance` is the Position's open Advance index, if any (the optional account). */
export const accrueNativeYieldIx = (position: PublicKey, openAdvance: number | null) =>
  core(
    [
      meta(position, true),
      meta(custodyPda(position)),
      meta(vaultPda(position)),
      meta(POOL),
      // Optional account: the program id stands for `None`.
      meta(openAdvance === null ? TESORO_CORE_ID : sourcePda(position, openAdvance), openAdvance !== null),
    ],
    "accrue_native_yield",
  );

const payoutRemaining = (position: PublicKey, dest: PublicKey): AccountMeta[] => [
  meta(custodyPda(position), true),
  meta(vaultPda(position), true),
  meta(dest, true),
  meta(POOL),
  meta(TOKEN_PROGRAM_ID),
];

/** Redeem Gemas of `source`: the holder is paid simSOL into their own token account. */
export function redeemIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint) {
  const account = accountPda(holder);
  const i = core(
    [meta(holder, false, true), meta(account, true), meta(position), meta(source, true), meta(holdingPda(account, source), true)],
    "redeem",
    u64(gemas),
  );
  i.keys.push(...payoutRemaining(position, simSolAta(holder)));
  return i;
}

/** Debt must be zero on chain (send `accrueNativeYieldIx` first). Returns the Principal shares to the owner. */
export function unlockIx(owner: PublicKey, position: PublicKey) {
  const i = core([meta(owner, false, true), meta(accountPda(owner)), meta(position, true)], "unlock");
  i.keys.push(...payoutRemaining(position, simSolAta(owner)));
  return i;
}

export const sweepNativeSurplusIx = (owner: PublicKey, position: PublicKey) =>
  core(
    [
      meta(owner, false, true),
      meta(accountPda(owner)),
      meta(position),
      meta(custodyPda(position), true),
      meta(vaultPda(position), true),
      meta(simSolAta(owner), true),
      meta(POOL),
      meta(TOKEN_PROGRAM_ID),
    ],
    "sweep_native_surplus",
  );

// --- Pure math ---------------------------------------------------------------------------------

export interface PoolParams {
  baseRate: bigint;
  baseTs: number;
  apyBps: number;
  speedup: number;
}

/** sim_lst rate (SOL per simSOL, 1e9 fixed point) at `nowSec`, as the program computes it. */
export function rateAt(p: PoolParams, nowSec: number): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor(nowSec) - p.baseTs));
  return p.baseRate + (p.baseRate * BigInt(p.apyBps) * elapsed * BigInt(p.speedup)) / (10_000n * BigInt(YEAR));
}

/** SOL base units a simSOL amount is worth at `rate`. */
export const sharesValue = (shares: bigint, rate: bigint) => (shares * rate) / RATE_SCALE;

/** Advance sizing exactly as `Position::open_advance`: 100% of the projected yield, floored to whole Gemas. */
export function quoteNativeAdvance(principalLamports: bigint, rateBps: number, months: number, priceMicroUsd: bigint) {
  const projectedUnits = (principalLamports * BigInt(rateBps) * BigInt(months)) / (12n * 10_000n);
  const gemas = (projectedUnits * priceMicroUsd) / 10n ** 13n;
  return { projectedUnits, gemas };
}

/**
 * Unlock Estimate (ms since epoch): when the vault's accrued yield covers the Source's Debt at the
 * pool's current growth. Null when it cannot be projected (nothing in the vault, no growth). An
 * estimate, never a promise: it moves with the provider's actual yield.
 */
export function unlockEstimateMs(args: {
  source: SourceMath | null;
  vaultShares: bigint;
  redeemedUnits: bigint;
  principalLamports: bigint;
  pool: PoolParams;
  nowMs: number;
}): number | null {
  const { source, vaultShares, redeemedUnits, principalLamports, pool, nowMs } = args;
  if (!source) return null;
  const needed = unitsToRepay(source) + source.yieldUnits; // total yield units that repay every live Gema
  const rate = rateAt(pool, nowMs / 1000);
  const accrued = sharesValue(vaultShares, rate) + redeemedUnits - principalLamports;
  const have = accrued > source.yieldUnits ? accrued : source.yieldUnits;
  if (have >= needed) return nowMs;
  const perSec = (Number(vaultShares) * Number(pool.baseRate) * pool.apyBps * pool.speedup) / (10_000 * YEAR) / Number(RATE_SCALE);
  if (!(perSec > 0)) return null;
  return nowMs + (Number(needed - have) / perSec) * 1000;
}

/** Debt in Gemas if the vault's yield were applied now (what a crank would leave). */
export function projectedDebtGemas(source: SourceMath | null, vaultShares: bigint, redeemedUnits: bigint, principalLamports: bigint, pool: PoolParams, nowMs: number): bigint {
  if (!source) return 0n;
  const accrued = sharesValue(vaultShares, rateAt(pool, nowMs / 1000)) + redeemedUnits - principalLamports;
  const y = accrued > source.yieldUnits ? accrued : source.yieldUnits;
  const l = live(source);
  const c = covered({ ...source, yieldUnits: y });
  return l - c;
}

/** simSOL base units that redeeming `gemas` of a Source pays now (floor, as the program computes it). */
export function redeemPayoutShares(source: SourceMath, gemas: bigint, rate: bigint): bigint {
  const units = (gemas * source.unitNum) / source.unitDen;
  return (units * RATE_SCALE) / rate;
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
}

export interface NativeInfo {
  position: PublicKey;
  custody: PublicKey;
  status: "locked" | "unlocked";
  principalLamports: bigint;
  rateBps: number;
  advances: number;
  openAdvance: number | null;
  cumulativeYield: bigint;
  freeYield: bigint;
  vaultShares: bigint;
  redeemedUnits: bigint;
  /** The latest Advance's Source (kept after Debt reaches zero), null before the first Advance. */
  source: { key: PublicKey; index: number; horizonMonths: number; math: SourceMath } | null;
}

export async function fetchNativeMarket(c: Connection, wallet: PublicKey): Promise<NativeMarket> {
  const [pool, feed, ata] = await c.getMultipleAccountsInfo([POOL, PRICE_FEED, simSolAta(wallet)], "confirmed");
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
  return {
    pool: { baseRate: rdU64(d, 72), baseTs: Number(rdI64(d, 80)), apyBps: rdU32(d, 88), speedup: rdU32(d, 92) },
    price,
    simSol,
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
  let source: NativeInfo["source"] = null;
  if (advances > 0) {
    const key = sourcePda(position, advances - 1);
    const src = await c.getAccountInfo(key, "confirmed");
    if (src) source = parseSource(key, Buffer.from(src.data));
  }
  return {
    position,
    custody,
    status,
    principalLamports,
    rateBps,
    advances,
    openAdvance,
    cumulativeYield,
    freeYield,
    vaultShares: rdU64(vault.data, 64),
    redeemedUnits,
    source,
  };
}
