import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { debtGemas, unitsToRepay, type SourceMath } from "../../app/src/lib/chain/ledger.ts";
import { RATE_SCALE, accrueNativeYieldIx, accruedAt, custodyPda, fetchNativeMarket, parseSource, rdI64, rdU64, sourcePda, treasuryPda, SIM_SOL_MINT, type PoolParams } from "../../app/src/lib/chain/native.ts";
import { accrueStakePoolYieldIx, parseStakePool, stakePoolRate, tokenTreasuryVaultPda } from "../../app/src/lib/chain/stake-pool.ts";
import { DEFAULT_YIELD_FEE_BPS } from "../../app/src/lib/chain/yield.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { pk } from "./runtime.ts";

const status = (o: object) => Object.keys(o)[0];

/** A crank is sent once it repays at least this many Gemas of Debt, or repays the rest of it. */
const MIN_GEMAS = BigInt(process.env.KEEPER_YIELD_MIN_GEMAS ?? 10);
/** Smaller gains are still applied when the Position was last cranked longer ago than this (one simulated month). */
const MAX_AGE_MS = Number(process.env.KEEPER_YIELD_MAX_AGE_SECS ?? 600) * 1000;
/** A Position is cranked at most this often, unless the crank repays the rest of its Debt. */
const MIN_INTERVAL_MS = Number(process.env.KEEPER_YIELD_MIN_INTERVAL_SECS ?? 120) * 1000;
/** Positions per transaction, and transactions per pass, so the job stays short and the others get their turn. */
const PER_TX = 4;
const MAX_TX_PER_PASS = Number(process.env.KEEPER_YIELD_MAX_TX ?? 3);

// NativeCustody: disc 8, bump, vault_bump, 5 keys, rate_at_open, deposited, redeemed_units, tracked_shares, last_accrual_ts.
const REDEEMED_AT = 8 + 2 + 5 * 32 + 16;
const TRACKED_AT = REDEEMED_AT + 8;
const ACCRUAL_AT = TRACKED_AT + 8;

const lastCrank = new Map<string, number>();
/** Positions whose batch failed: sent alone from then on, so one bad Position cannot block the rest. */
const solo = new Set<string>();
/** A Position whose own crank failed is left alone until then. */
const retryAt = new Map<string, number>();

export interface Reading {
  principal: bigint;
  cumulative: bigint;
  /** `tracked_shares` of the custody; null for a custody in the old layout. */
  trackedShares: bigint | null;
  redeemedUnits: bigint;
  source: SourceMath | null;
  /** Position's own APY and the custody's `last_accrual_ts`; null while the custody is not migrated. */
  rateBps: number;
  lastAccrualTs: number | null;
}

/**
 * Gemas of Debt one `accrue_native_yield` would repay at `nowMs`, as the program applies it: the yield minted since
 * `last_accrual_ts` (per-Position model, net of the Treasury's Yield Fee) plus what the vault already holds, past the
 * Position's `cumulative_yield`, capped at what repays the open Source. Null when it cannot be computed.
 */
export function crankGain(r: Reading, pool: PoolParams, nowMs: number, yieldFeeBps = DEFAULT_YIELD_FEE_BPS): { gain: bigint; clears: boolean } | null {
  if (r.trackedShares === null || r.lastAccrualTs === null || !r.source) return null;
  const accrued = accruedAt({
    vaultShares: r.trackedShares,
    redeemedUnits: r.redeemedUnits,
    principalLamports: r.principal,
    pool,
    clock: { rateBps: r.rateBps, lastAccrualTs: r.lastAccrualTs },
    nowMs,
    yieldFeeBps,
  });
  return gainOf(accrued, r, r.source);
}

/** Gemas of Debt that applying `accrued` cumulative yield would repay, capped at what repays the open Source. */
function gainOf(accrued: bigint, r: Reading, src: SourceMath): { gain: bigint; clears: boolean } {
  if (accrued <= r.cumulative) return { gain: 0n, clears: false };
  const need = unitsToRepay(src);
  const take = accrued - r.cumulative < need ? accrued - r.cumulative : need;
  const before = debtGemas(src);
  const after = debtGemas({ ...src, yieldUnits: src.yieldUnits + take });
  return { gain: before - after, clears: before > 0n && after === 0n };
}

/**
 * The same for a stake pool custody (a real staking token): yield is the pool rate's growth. The program first takes the
 * Yield Fee on the growth since `lastRate` out of `trackedShares`, then reads `tracked * rate - principal + redeemed`.
 */
export function stakeCrankGain(r: Reading & { lastRate: bigint }, rate: bigint, yieldFeeBps = DEFAULT_YIELD_FEE_BPS): { gain: bigint; clears: boolean } | null {
  if (r.trackedShares === null || !r.source || rate <= 0n) return null;
  let tracked = r.trackedShares;
  if (rate > r.lastRate) {
    const growth = (tracked * (rate - r.lastRate)) / RATE_SCALE;
    const feeShares = (((growth * BigInt(yieldFeeBps)) / 10_000n) * RATE_SCALE) / rate;
    tracked -= feeShares < tracked ? feeShares : tracked;
  }
  const value = (tracked * rate) / RATE_SCALE + r.redeemedUnits;
  return gainOf(value > r.principal ? value - r.principal : 0n, r, r.source);
}

/** Why a Position is worth a crank now, or null to leave it for a later pass. */
export function crankReason(g: { gain: bigint; clears: boolean } | null, lastAt: number | undefined, nowMs: number): string | null {
  const age = nowMs - (lastAt ?? 0);
  const stale = age >= MAX_AGE_MS;
  if (g === null) return stale ? "periodic (gain unknown)" : null;
  if (g.clears) return "repays the Debt";
  if (age < MIN_INTERVAL_MS) return null;
  if (g.gain >= MIN_GEMAS) return `repays ${g.gain} Gemas`;
  if (g.gain > 0n && stale) return `periodic, repays ${g.gain} Gemas`;
  return null;
}

/** Groups the Positions to crank into transactions, at most `maxTx`: best gain first, `solo` ones alone. */
export function batches<T extends { key: string; gain: bigint }>(due: T[], soloKeys: Set<string>, perTx = PER_TX, maxTx = MAX_TX_PER_PASS): T[][] {
  const sorted = [...due].sort((a, b) => (a.gain === b.gain ? 0 : a.gain > b.gain ? -1 : 1));
  const out: T[][] = [];
  let group: T[] = [];
  for (const d of sorted) {
    if (out.length >= maxTx) break;
    if (soloKeys.has(d.key)) {
      out.push([d]);
      continue;
    }
    group.push(d);
    if (group.length === perTx) {
      out.push(group);
      group = [];
    }
  }
  if (group.length && out.length < maxTx) out.push(group);
  return out;
}

/**
 * Job 3: yield. A Solana-native Position (simSOL custody) with Debt gets the permissionless `accrue_native_yield`,
 * which applies the vault's SIMULATED yield (sim_lst runs 1 month = ~10 min) to its Debt, only when it is worth a
 * transaction (see `crankReason`): at most every `MIN_INTERVAL_MS` per Position unless it repays the rest of the Debt. Several Positions share a transaction, a pass sends at most `MAX_TX_PER_PASS`, and
 * the job spends at most its share of the hourly cap (`KEEPER_YIELD_BUDGET_SHARE`). A Position has Debt exactly
 * while `open_advance` is set. ETH Positions are handled by src/eth.ts and src/bridge.ts.
 */
export async function yieldJob(ctx: Ctx): Promise<number> {
  return (await simulatedYieldJob(ctx)) + (await stakePoolYieldJob(ctx));
}

async function simulatedYieldJob(ctx: Ctx): Promise<number> {
  const positions: any[] = await ctx.core.account.positionState.all();
  const native = positions.filter((p) => {
    const i = p.account.inner;
    return status(i.sourceChain) === "solana" && pk(i.sourceAsset).equals(SIM_SOL_MINT);
  });
  const owing = native.filter((p) => status(p.account.inner.status) === "locked" && p.account.inner.openAdvance !== null && p.account.inner.openAdvance !== undefined);
  if (!owing.length) {
    log("yield", "-", `${native.length} native Position(s), none with Debt`);
    return 0;
  }

  const market = await fetchNativeMarket(ctx.conn, ctx.payer.publicKey);
  const treasury = market.treasury;
  if (!treasury) {
    log("yield", "-", `SKIP ${owing.length} Position(s) with Debt: the Treasury is not set up (accrue_native_yield needs it; run keeper/scripts/fund-treasury.ts)`);
    return 0;
  }
  const pool = market.pool;
  const yieldFeeBps = treasury.yieldFeeBps;
  const keys = owing.flatMap(({ publicKey, account }) => [custodyPda(publicKey), sourcePda(publicKey, Number(account.inner.openAdvance))]);
  const infos: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await ctx.conn.getMultipleAccountsInfo(keys.slice(i, i + 100))));

  const nowMs = Date.now();
  const due: { key: string; position: PublicKey; open: number; gain: bigint; why: string }[] = [];
  owing.forEach(({ publicKey, account }, i) => {
    const [cust, src] = [infos[2 * i], infos[2 * i + 1]];
    const key = (publicKey as PublicKey).toBase58();
    const g = cust
      ? crankGain(
          {
            principal: BigInt(account.inner.principal.toString()),
            cumulative: BigInt(account.inner.cumulativeYield.toString()),
            trackedShares: cust.data.length >= TRACKED_AT + 8 ? rdU64(cust.data, TRACKED_AT) : null,
            redeemedUnits: rdU64(cust.data, REDEEMED_AT),
            source: src ? parseSource(sourcePda(publicKey, Number(account.inner.openAdvance)), Buffer.from(src.data)).math : null,
            rateBps: Number(account.inner.rateBps),
            lastAccrualTs: cust.data.length >= ACCRUAL_AT + 8 ? Number(rdI64(cust.data, ACCRUAL_AT)) : null,
          },
          pool,
          nowMs,
          yieldFeeBps,
        )
      : null;
    if ((retryAt.get(key) ?? 0) > nowMs) return;
    const why = crankReason(g, lastCrank.get(key), nowMs);
    if (why) due.push({ key, position: publicKey, open: Number(account.inner.openAdvance), gain: g?.gain ?? 0n, why });
  });

  let actions = 0;
  for (const group of batches(due, solo)) {
    const subject = group.length === 1 ? `position=${shortKey(group[0].position)}` : `positions=${group.map((d) => shortKey(d.position)).join(",")}`;
    const what = `accrue_native_yield (${group.map((d) => d.why).join("; ")})`;
    const r = await act(ctx, "yield", subject, what, () => ctx.bp.sendBase(ctx.signer, group.map((d) => accrueNativeYieldIx(d.position, d.open))), ctx.yieldShare);
    if (r.ok) {
      actions += group.length;
      for (const d of group) lastCrank.set(d.key, Date.now());
    } else if (r.detail === "budget") {
      break;
    } else if (group.length > 1) {
      for (const d of group) solo.add(d.key);
    } else {
      retryAt.set(group[0].key, Date.now() + MAX_AGE_MS);
    }
  }
  log("yield", "-", `${native.length} native Position(s), ${owing.length} with Debt, ${due.length} worth a crank, ${actions} cranked`);
  return actions;
}

/** NativeCustody: the struct, then the stake pool marker byte and the rate the Yield Fee is settled at (state.rs). */
const CUSTODY_SPACE = ACCRUAL_AT + 8;
const STAKE_POOL_MARKER = 2;
/** Treasury: disc 8, 3 bumps, 2 fee rates, account, vault. */
const TREASURY_VAULT_AT = 8 + 3 + 4 + 32;

/** Whether custody data belongs to a stake pool custody, and the rate its fee is settled at. */
export const stakeCustodyRate = (data: Uint8Array): bigint | null =>
  data.length >= CUSTODY_SPACE + 9 && data[CUSTODY_SPACE] === STAKE_POOL_MARKER ? rdU64(data, CUSTODY_SPACE + 1) : null;

/**
 * Job 3b: yield of real staking tokens (mainnet). A Solana Position whose custody is valued by a stake pool and that has
 * Debt gets `accrue_stake_pool_yield` when the pool's rate growth repays enough of it (same thresholds as `crankReason`).
 * The Position's token can be any the SolSource has named, so the pool and the Treasury's vault of that token come from the
 * custody and the Treasury, not from a constant.
 */
async function stakePoolYieldJob(ctx: Ctx): Promise<number> {
  const positions: any[] = await ctx.core.account.positionState.all();
  const owing = positions.filter((p) => {
    const i = p.account.inner;
    return status(i.sourceChain) === "solana" && !pk(i.sourceAsset).equals(SIM_SOL_MINT) && status(i.status) === "locked" && i.openAdvance !== null && i.openAdvance !== undefined;
  });
  if (!owing.length) return 0;

  const custodyInfos: (AccountInfo<Buffer> | null)[] = [];
  const keys = owing.map(({ publicKey }) => custodyPda(publicKey));
  for (let i = 0; i < keys.length; i += 100) custodyInfos.push(...(await ctx.conn.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  const stake = owing.flatMap((p, i) => {
    const c = custodyInfos[i];
    const lastRate = c ? stakeCustodyRate(c.data) : null;
    return c && lastRate !== null ? [{ p, custody: c.data, lastRate, pool: new PublicKey(c.data.subarray(8 + 2 + 2 * 32, 8 + 2 + 3 * 32)), mint: new PublicKey(c.data.subarray(8 + 2 + 3 * 32, 8 + 2 + 4 * 32)) }] : [];
  });
  if (!stake.length) return 0;

  const treasuryInfo = await ctx.conn.getAccountInfo(treasuryPda());
  if (!treasuryInfo || treasuryInfo.data.length < TREASURY_VAULT_AT + 32) {
    log("yield", "-", `SKIP ${stake.length} stake pool Position(s) with Debt: the Treasury is not set up`);
    return 0;
  }
  const yieldFeeBps = treasuryInfo.data.readUInt16LE(11);
  const originalVault = new PublicKey(treasuryInfo.data.subarray(TREASURY_VAULT_AT, TREASURY_VAULT_AT + 32));

  const poolKeys = [...new Set(stake.map((s) => s.pool.toBase58()))].map((k) => new PublicKey(k));
  const poolInfos = await ctx.conn.getMultipleAccountsInfo([...poolKeys, originalVault, ...stake.map((s) => sourcePda(s.p.publicKey, Number(s.p.account.inner.openAdvance)))]);
  const rates = new Map<string, bigint>();
  poolKeys.forEach((k, i) => {
    const v = poolInfos[i] && parseStakePool(poolInfos[i]!.data);
    const rate = v ? stakePoolRate(v.totalLamports, v.poolTokenSupply) : null;
    if (rate) rates.set(k.toBase58(), rate);
  });
  const originalMint = poolInfos[poolKeys.length] ? new PublicKey(poolInfos[poolKeys.length]!.data.subarray(0, 32)) : null;
  const sourceInfos = poolInfos.slice(poolKeys.length + 1);

  const nowMs = Date.now();
  const due: { key: string; position: PublicKey; pool: PublicKey; vault: PublicKey; open: number; gain: bigint; why: string }[] = [];
  stake.forEach((s, i) => {
    const { publicKey, account } = s.p;
    const key = (publicKey as PublicKey).toBase58();
    const rate = rates.get(s.pool.toBase58());
    const src = sourceInfos[i];
    const g =
      rate && src
        ? stakeCrankGain(
            {
              principal: BigInt(account.inner.principal.toString()),
              cumulative: BigInt(account.inner.cumulativeYield.toString()),
              trackedShares: rdU64(s.custody, TRACKED_AT),
              redeemedUnits: rdU64(s.custody, REDEEMED_AT),
              source: parseSource(sourcePda(publicKey, Number(account.inner.openAdvance)), Buffer.from(src.data)).math,
              rateBps: Number(account.inner.rateBps),
              lastAccrualTs: null,
              lastRate: s.lastRate,
            },
            rate,
            yieldFeeBps,
          )
        : null;
    if ((retryAt.get(key) ?? 0) > nowMs) return;
    const why = crankReason(g, lastCrank.get(key), nowMs);
    if (why) due.push({ key, position: publicKey, pool: s.pool, vault: originalMint?.equals(s.mint) ? originalVault : tokenTreasuryVaultPda(s.mint), open: Number(account.inner.openAdvance), gain: g?.gain ?? 0n, why });
  });

  let actions = 0;
  for (const group of batches(due, solo)) {
    const subject = group.length === 1 ? `position=${shortKey(group[0].position)}` : `positions=${group.map((d) => shortKey(d.position)).join(",")}`;
    const what = `accrue_stake_pool_yield (${group.map((d) => d.why).join("; ")})`;
    const r = await act(ctx, "yield", subject, what, () => ctx.bp.sendBase(ctx.signer, group.map((d) => accrueStakePoolYieldIx(d.position, d.pool, d.vault, d.open))), ctx.yieldShare);
    if (r.ok) {
      actions += group.length;
      for (const d of group) lastCrank.set(d.key, Date.now());
    } else if (r.detail === "budget") {
      break;
    } else if (group.length > 1) {
      for (const d of group) solo.add(d.key);
    } else {
      retryAt.set(group[0].key, Date.now() + MAX_AGE_MS);
    }
  }
  log("yield", "-", `${stake.length} stake pool Position(s), ${due.length} worth a crank, ${actions} cranked`);
  return actions;
}
