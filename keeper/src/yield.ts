import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { debtGemas, unitsToRepay, type SourceMath } from "../../app/src/lib/chain/ledger.ts";
import { accrueNativeYieldIx, accruedAt, custodyPda, fetchNativeMarket, parseSource, rdI64, rdU64, sourcePda, SIM_SOL_MINT, type PoolParams } from "../../app/src/lib/chain/native.ts";
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
 * `last_accrual_ts` (per-Position model) plus what the vault already holds, past the Position's `cumulative_yield`,
 * capped at what repays the open Source. Null when it cannot be computed.
 */
export function crankGain(r: Reading, pool: PoolParams, nowMs: number): { gain: bigint; clears: boolean } | null {
  if (r.trackedShares === null || r.lastAccrualTs === null || !r.source) return null;
  const accrued = accruedAt({
    vaultShares: r.trackedShares,
    redeemedUnits: r.redeemedUnits,
    principalLamports: r.principal,
    pool,
    clock: { rateBps: r.rateBps, lastAccrualTs: r.lastAccrualTs },
    nowMs,
  });
  if (accrued <= r.cumulative) return { gain: 0n, clears: false };
  const need = unitsToRepay(r.source);
  const take = accrued - r.cumulative < need ? accrued - r.cumulative : need;
  const before = debtGemas(r.source);
  const after = debtGemas({ ...r.source, yieldUnits: r.source.yieldUnits + take });
  return { gain: before - after, clears: before > 0n && after === 0n };
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

  const pool = (await fetchNativeMarket(ctx.conn, ctx.payer.publicKey)).pool;
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
