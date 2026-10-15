import "./polyfill";
import {
  Connection,
  PublicKey,
  type AccountInfo,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { debtGemas, sourceView, unitsToRepayTotal, type SourceMath } from "./ledger";
import { parseTreasury, parseVaultShares, type TreasuryRates } from "./fees";
import { DEFAULT_YIELD_FEE_BPS, SPEEDUP, advanceUnits, positionAccrued, secondsUntilNet, type PositionClock } from "./yield";

/**
 * Solana-native Positions (one shared simSOL custody, tesoro_core) and the SIMULATED sim_lst pool. Instructions
 * are encoded by hand and checked against the IDL in native.test.ts. A Position's Debt, redeemable amount and
 * free yield are derived from the clock (`nativeNow`), never recorded by a crank (ADR 0010).
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
  init_native_custody: "43d4ae0fe7cf117b",
  redeem: "b80c569546c461e1",
  unlock: "659b28159ebd38cb",
  init_treasury: "6998ad339e97310e",
  fund_treasury: "479a2ddcce20aeef",
  instant_redeem: "bb6bd07de0ed285d",
  redeem_treasury: "109798e01b5bb9cd",
  set_extend_limit: "419bcc697b0524a5",
} as const;
const disc = (name: keyof typeof DISC) => Buffer.from(DISC[name], "hex");

export const POOL = pda([s("pool")], SIM_LST_ID);
export const SIM_SOL_MINT = pda([s("mint")], SIM_LST_ID);
export const CONFIG = pda([s("config")]);
export const PRICE_FEED = pda([s("price"), SIM_SOL_MINT.toBuffer()]);

/** tesoro_core `["yield"]` PDA: signs `sim_lst::mint_yield` when a Redeem or Unlock pays yield out. */
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
/** The one shared custody of every native Position, and the simSOL vault that holds their Principal. */
export const nativeCustodyPda = () => pda([s("native")]);
export const nativeVaultPda = () => pda([s("native_vault")]);
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
      meta(treasuryPda()),
      meta(nativeCustodyPda(), true),
      meta(nativeVaultPda(), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "open_native_position",
    u64(nonce),
    u64(lstAmount),
  );
}

/**
 * `advances` is the Position's advance count before this one (0 for a new Position). `openAdvance` is the
 * Position's open Advance, which the program closes here: required whenever one is open, even at Debt 0.
 */
export function takeNativeAdvanceIx(owner: PublicKey, position: PublicKey, advances: number, months: number, openAdvance: number | null = null) {
  const source = sourcePda(position, advances);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(position, true),
      meta(PRICE_FEED),
      meta(POOL),
      // Optional account: the program id stands for `None`.
      meta(openAdvance === null ? TESORO_CORE_ID : sourcePda(position, openAdvance), openAdvance !== null),
      meta(source, true),
      meta(holdingPda(accountPda(owner), source), true),
      meta(SystemProgram.programId),
    ],
    "take_native_advance",
    Buffer.from([months]),
  );
}

export const extendLimitPda = (account: PublicKey) => pda([s("extend_limit"), account.toBuffer()]);

/** `info.source.index` is the Position's open Advance; the owner signs alone and `extraMonths` is added to its Horizon (1 to 12 minus the Horizon so far). The owner pays for their Extend Limit account on the first Extend (ADR 0009). */
export function extendNativeAdvanceIx(owner: PublicKey, position: PublicKey, source: number, extraMonths: number) {
  const src = sourcePda(position, source);
  return core(
    [
      meta(owner, true, true),
      meta(accountPda(owner), true),
      meta(position, true),
      meta(POOL),
      meta(src, true),
      meta(holdingPda(accountPda(owner), src), true),
      meta(extendLimitPda(accountPda(owner)), true),
      meta(SystemProgram.programId),
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

/**
 * The accounts that mint the yield a Redeem or Unlock pays out, after the instruction's own: the sim_lst pool, the
 * simSOL account that is paid, the mint, sim_lst's yield config and the Tesoro yield authority (which signs the mint), the programs.
 */
const yieldRemaining = (dest: PublicKey): AccountMeta[] => [
  meta(POOL),
  meta(dest, true),
  meta(SIM_SOL_MINT, true),
  meta(yieldConfigPda()),
  meta(yieldAuthorityPda()),
  meta(SIM_LST_ID),
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
  i.keys.push(...yieldRemaining(simSolAta(holder)));
  return i;
}

/**
 * Instant Redeem: the holder sells won Gemas of a native Source and the treasury vault pays simSOL into
 * their token account in the same transaction (fails when the vault holds less).
 */
export function instantRedeemIx(holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint) {
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
      meta(treasuryVaultPda(), true),
      meta(simSolAta(holder), true),
      meta(POOL),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "instant_redeem",
    u64(gemas),
  );
}

/** Permissionless: the Treasury Account redeems Gemas it bought; the simSOL goes into the treasury vault. */
export function redeemTreasuryIx(position: PublicKey, source: PublicKey, gemas: bigint) {
  const treasuryAccount = treasuryAccountPda();
  const i = core(
    [meta(treasuryPda()), meta(treasuryAccount, true), meta(position), meta(source, true), meta(holdingPda(treasuryAccount, source), true)],
    "redeem_treasury",
    u64(gemas),
  );
  i.keys.push(...yieldRemaining(treasuryVaultPda()));
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

/**
 * Debt must be zero at the clock. Returns the Principal from the shared vault and mints the free yield to the owner.
 * `openAdvance` is the Position's open Advance, which the program closes here (its Source is required whenever one is open).
 */
export function unlockIx(owner: PublicKey, position: PublicKey, openAdvance: number | null = null) {
  const i = core([meta(owner, false, true), meta(accountPda(owner)), meta(position, true)], "unlock");
  i.keys.push(meta(nativeCustodyPda(), true), meta(nativeVaultPda(), true), ...yieldRemaining(simSolAta(owner)));
  if (openAdvance !== null) i.keys.push(meta(sourcePda(position, openAdvance), true));
  return i;
}

/** The accounts a native `return_own` adds after its own: the sim_lst pool, whose speedup times the Position's yield. */
export const returnOwnRemaining = (): AccountMeta[] => [meta(POOL)];

/** Admin, once: creates the shared custody and its simSOL vault. */
export const initNativeCustodyIx = (admin: PublicKey) =>
  core(
    [
      meta(admin, true, true),
      meta(CONFIG),
      meta(POOL),
      meta(SIM_SOL_MINT),
      meta(nativeCustodyPda(), true),
      meta(nativeVaultPda(), true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    "init_native_custody",
  );

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

/** The speedup to time yield by: the pool's, or the devnet constant until the pool has been read. */
export const speedupOf = (pool: Pick<PoolParams, "speedup"> | null | undefined): number => pool?.speedup ?? Number(SPEEDUP);

/** A native Position's yield clock: what it fixed at open. */
export const clockOf = (info: Pick<NativeInfo, "principalLamports" | "rateBps" | "yieldFeeBps" | "openedAt">): PositionClock => ({
  principal: info.principalLamports,
  rateBps: info.rateBps,
  yieldFeeBps: info.yieldFeeBps,
  openedAt: info.openedAt,
});

/** What a native Position fixes: enough to derive its Sources' Debt at any moment without the sim_lst custody. */
export interface NativeFacts extends PositionClock {
  appliedNet: bigint;
  openAdvance: number | null;
}

/** A Source of a native Position as it stands at `nowSec` (the open Advance derived from the clock, a closed one as stored). */
export function sourceAtClock(facts: NativeFacts, index: number, math: SourceMath, speedup: number, nowSec: number): SourceMath {
  return sourceView(facts, index, math, positionAccrued(facts, speedup, nowSec).net);
}

/** The pool's `speedup` from the raw sim_lst Pool account data (what `marketFrom` reads). */
export const poolSpeedup = (data: Uint8Array): number => rdU32(data, 92);

/** A native Position at one moment, derived from the clock exactly as the program does (`position_accrued`, `source_view`). */
export interface NativeNow {
  /** Net Accrued Yield since open (frozen at the last settled amount once Unlocked), source-asset units. */
  accrued: bigint;
  /** The latest Advance's Source with the yield it counts now; null before the first Advance. */
  source: SourceMath | null;
  /** Outstanding Debt of the latest Advance, Gemas. */
  debtGemas: bigint;
  /** Yield that is the owner's, not yet paid out: banked free yield plus what the open Advance does not need. */
  freeUnits: bigint;
}

export function nativeNow(info: NativeInfo, speedup: number, nowSec: number): NativeNow {
  if (info.status === "unlocked") {
    const stored = info.source?.math ?? null;
    return { accrued: info.appliedNet, source: stored, debtGemas: stored ? debtGemas(stored) : 0n, freeUnits: sat(info.freeYield, info.freeYieldClaimed) };
  }
  const net = positionAccrued(clockOf(info), speedup, nowSec).net;
  const src = info.source;
  const view = src ? sourceView(info, src.index, src.math, net) : null;
  const counted = sat(net, info.appliedNet);
  const unsettled = view && info.openAdvance === src!.index ? sat(counted, view.yieldUnits) : counted;
  return { accrued: net, source: view, debtGemas: view ? debtGemas(view) : 0n, freeUnits: sat(info.freeYield, info.freeYieldClaimed) + unsettled };
}

const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/**
 * Unlock Estimate (ms since epoch): when the Position's net Accrued Yield past `appliedNet` covers everything `source`
 * still owes. Null when it cannot be projected (nothing earning). An estimate, never a promise: it moves with the pool's speedup.
 */
export function unlockEstimateMs(args: { clock: PositionClock; speedup: number; appliedNet: bigint; source: SourceMath | null; nowMs: number }): number | null {
  const { clock, speedup, appliedNet, source, nowMs } = args;
  if (!source) return null;
  const target = appliedNet + unitsToRepayTotal(source);
  if (positionAccrued(clock, speedup, Math.floor(nowMs / 1000)).net >= target) return nowMs;
  const at = secondsUntilNet(clock, speedup, target);
  return at === null ? null : Math.max(nowMs, at * 1000);
}

/** Debt in Gemas of `info` at `atMs`, as the program would compute it then. */
export const debtGemasAt = (info: NativeInfo, speedup: number, atMs: number): bigint => nativeNow(info, speedup, Math.floor(atMs / 1000)).debtGemas;

/** simSOL base units that redeeming `gemas` of a Source pays now (floor, as the program computes it). */
export function redeemPayoutShares(source: Pick<SourceMath, "unitNum" | "unitDen">, gemas: bigint, rate: bigint): bigint {
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
  /** Yield Fee and Instant Redeem Fee rates; null until `init_treasury` has run (use `ratesOf` for the launch rates). */
  treasury: TreasuryRates | null;
  /** simSOL the treasury vault holds to pay Instant Redeems; null while there is no Treasury. */
  treasuryShares: bigint | null;
}

export interface NativeInfo {
  position: PublicKey;
  status: "locked" | "unlocked";
  principalLamports: bigint;
  rateBps: number;
  /** The Yield Fee in basis points, fixed on the Position at open. */
  yieldFeeBps: number;
  /** Unix seconds the Position opened: its Accrued Yield counts from here. */
  openedAt: number;
  /** Net Accrued Yield already settled (consumed by closed Advances or banked as free yield). */
  appliedNet: bigint;
  /** Banked free yield and how much of it was paid out, source-asset units. */
  freeYield: bigint;
  freeYieldClaimed: bigint;
  advances: number;
  openAdvance: number | null;
  /** The latest Advance's Source as stored (kept after Debt reaches zero; its yield counts only through `nativeNow`), null before the first Advance. */
  source: { key: PublicKey; index: number; horizonMonths: number; math: SourceMath } | null;
}

/** The accounts `marketFrom` reads, in order: pool, price feed, the wallet's simSOL token account, Treasury, Treasury vault. */
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

/** Reads a native Position with its latest Source. Null when it is not a native Position. */
export async function fetchNativeInfo(c: Connection, position: PublicKey): Promise<NativeInfo | null> {
  const pos = await c.getAccountInfo(position, "confirmed");
  if (!pos || !pos.owner.equals(TESORO_CORE_ID)) return null;
  const advances = rdU32(Buffer.from(pos.data), NATIVE_ADVANCES_AT);
  const src = advances > 0 ? await c.getAccountInfo(sourcePda(position, advances - 1), "confirmed") : null;
  return nativeInfoFrom(position, pos, src);
}

/** Byte offset of `advances` in a PositionState: disc, bump, id, owner, chain, asset, decimals, principal, rate, status. */
const NATIVE_ADVANCES_AT = 8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1;

/** `fetchNativeInfo` from accounts already read; `src` is the latest Source (index `advances - 1`), null when there is none. */
export function nativeInfoFrom(position: PublicKey, pos: AccountInfo<Buffer>, src: AccountInfo<Buffer> | null): NativeInfo {
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
  // open_advance (Option<u32>), last_seq, cumulative_yield; then the fields ADR 0010 added.
  o += (d[o] === 1 ? 5 : 1) + 8 + 8;
  const freeYield = rdU64(d, o);
  const freeYieldClaimed = rdU64(d, o + 8);
  const openedAt = Number(rdI64(d, o + 16));
  const appliedNet = rdU64(d, o + 24);
  // custody_shares (u64) sits at o + 32
  const yieldFeeBps = rdU16(d, o + 40);
  const source: NativeInfo["source"] = advances > 0 && src ? parseSource(sourcePda(position, advances - 1), Buffer.from(src.data)) : null;
  return { position, status, principalLamports, rateBps, yieldFeeBps, openedAt, appliedNet, freeYield, freeYieldClaimed, advances, openAdvance, source };
}
