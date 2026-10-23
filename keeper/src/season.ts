import anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type Keypair } from "@solana/web3.js";
import { PAYOUT_WINDOW_SECS, PRIZE_BPS, PRIZE_PLACES, payoutOpensAt, seasonAt, seasonEnd, seasonStart, standings, type Standing, type Win } from "../../app/src/lib/chain/season.ts";
import { act, log, type Ctx } from "./act.ts";
import { closeSeasonIx, fundSeasonPrizeNativeIx, fundSeasonPrizeStakeIx, growStoreIx, meta, paySeasonRankIx, recordSeasonIx, type Core } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { seasonWinsFromChain } from "./events-scan.ts";
import { MAX_STORE_LINES, OVERFLOW_ROUTE, OVERFLOW_SEASON, basketOf, decodeStore, economyAddress, keyOf, overflowAddress, pda, prizeSourceOf, routeOverflowId, seasonAddress, seasonOverflowId, slack, spillOf } from "./kit.ts";
import { OVERFLOW_STORE_AT, claimRecord, overflowRowOf } from "./overflow.ts";
import { oracleKey } from "./price.ts";
import { fundEvmPrizes, realEvmPrizeDeps } from "./batches.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { poolIsStale, updateStakePoolBalanceIx } from "./stake-pool-update.ts";
import { SIM_SOL_MINT, connReader, type Reader } from "./supply.ts";

/** A season is recorded this long after it ends, so settlements that were still landing at the boundary are in. */
const GRACE_SECS = Number(process.env.KEEPER_SEASON_GRACE_SECS ?? 10 * 60);
/** How many finished seasons back the job looks for one that is unrecorded or part paid. */
const LOOKBACK = 4;
/** A season with no wins is looked at again this often (scanning the event history costs RPC calls). */
const EMPTY_RECHECK_MS = 30 * 60_000;
/** (rank, line) payments sent in one transaction. */
const STEPS_PER_TX = Number(process.env.KEEPER_SEASON_STEPS_PER_TX ?? 3);

const emptyAt = new Map<number, number>();

/** Finished seasons the job should look at, oldest first: ended at least `graceSecs` ago, at most `lookback` back. */
export function seasonsToCheck(nowSecs: number, graceSecs = GRACE_SECS, lookback = LOOKBACK): number[] {
  const current = seasonAt(nowSecs);
  const out: number[] = [];
  for (let n = Math.max(1, current - lookback); n < current; n++) if (nowSecs >= seasonEnd(n) + graceSecs) out.push(n);
  return out;
}

/** record_season's points argument: one u64 per ranked Player, in rank order. */
export const seasonPoints = (table: Standing[]) => table.map((t) => new anchor.BN(t.points));

/** The ranks that are paid: the top `PRIZE_PLACES` of the table. */
export const topRanks = (wins: Win[]): Standing[] => standings(wins).slice(0, PRIZE_PLACES);

// ---- A recorded Season ---------------------------------------------------------------------------------------------

/** One line of the frozen budget: Gemas of one prize Source (or Pool line), each rank taking its share of every line. */
export interface BudgetLine {
  source: PublicKey;
  amount: bigint;
  paid: bigint;
}

export interface SeasonRecord {
  number: number;
  count: number;
  winners: PublicKey[];
  points: bigint[];
  lines: BudgetLine[];
  /** Per rank: how many budget lines it has been paid. */
  cursor: number[];
  recordedAt: number;
  voidedMask: number;
  closed: boolean;
}

/** A decoded `SeasonState` as the keeper reads it. */
export function seasonOf(account: any): SeasonRecord {
  const s = account.inner;
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const count = Number(s.count);
  return {
    number: Number(s.number),
    count,
    winners: (s.winners as number[][]).slice(0, count).map((w) => keyOf(w)),
    points: (s.points as { toString(): string }[]).slice(0, count).map(big),
    lines: (s.lines as any[]).map((l) => ({ source: keyOf(l.source), amount: big(l.amount), paid: big(l.paid) })),
    cursor: (s.cursor as number[]).slice(0, PRIZE_PLACES).map(Number),
    recordedAt: Number(s.window.recordedAt.toString()),
    voidedMask: Number(s.window.voidedMask),
    closed: !!s.closed,
  };
}

export async function readSeason(core: Core, n: number): Promise<SeasonRecord | null> {
  // A record written by the pre-economy program has another length and cannot be decoded: it counts as no record here
  // (seasonJob skips it, the Season was paid by the old program).
  const account = await core.account.seasonState.fetchNullable(seasonAddress(n)).catch(() => null);
  return account ? seasonOf(account) : null;
}

/** Gemas of budget line `line` that rank `rank` is paid (the program's rule: the same share of every line). */
export const rankShare = (line: BudgetLine, rank: number): bigint => (line.amount * BigInt(PRIZE_BPS[rank])) / 10_000n;
/** What a rank is paid in all, counting the lines already paid. */
export const rankTotal = (rec: SeasonRecord, rank: number): bigint => rec.lines.reduce((sum, l) => sum + rankShare(l, rank), 0n);

export interface PayStep {
  rank: number;
  line: number;
}

export type PayPlan = { kind: "wait"; until: number } | { kind: "pay"; steps: PayStep[] } | { kind: "close" } | { kind: "done" };

/**
 * What to do with a recorded season at `nowSecs`: the (rank, line) steps to pay now (rank by rank, each rank's lines in
 * order, voided ranks skipped), when the payout window opens, or the final close. Read from the chain every pass, so a
 * restart picks up exactly where it was.
 */
export function payPlan(rec: SeasonRecord, nowSecs: number): PayPlan {
  if (rec.closed) return { kind: "done" };
  const until = payoutOpensAt(rec.recordedAt);
  if (nowSecs < until) return { kind: "wait", until };
  const steps: PayStep[] = [];
  for (let rank = 0; rank < rec.count; rank++) {
    if (rec.voidedMask & (1 << rank)) continue;
    for (let line = rec.cursor[rank]; line < rec.lines.length; line++) steps.push({ rank, line });
  }
  return steps.length ? { kind: "pay", steps } : { kind: "close" };
}

const extraSigner = (ctx: Ctx, authority: Keypair): Keypair[] => (authority.publicKey.equals(ctx.payer.publicKey) ? [] : [authority]);

// ---- Who signs -----------------------------------------------------------------------------------------------------

/** The key that the Economy settings name as the Season keeper, when this process holds it (the keeper payer or the oracle key). */
export function seasonSigner(seasonKeeper: PublicKey, candidates: (Keypair | null)[]): Keypair | null {
  return candidates.find((k): k is Keypair => !!k && k.publicKey.equals(seasonKeeper)) ?? null;
}

/** What the job reaches the outside through: tests replace it. */
export interface SeasonDeps {
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  /** Every Match won in season `n`, from core's events. */
  wins(n: number): Promise<Win[]>;
  /** The current epoch (stake pools are judged by it). */
  epoch(): Promise<bigint>;
  /** Keys this process can sign a Season step with. */
  candidates(): (Keypair | null)[];
  /** Issues the prize of ETH/HYPE routes (`fund_season_prize_evm`); returns the number of transactions sent. */
  evmPrizes?(n: number, authority: Keypair, pool: PublicKey): Promise<number>;
}

export const realSeasonDeps = (ctx: Ctx): SeasonDeps => ({
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  wins: (n) => seasonWinsFromChain(ctx.conn, n, seasonStart(n), seasonEnd(n)),
  epoch: async () => BigInt((await ctx.conn.getEpochInfo("confirmed")).epoch),
  candidates: () => [ctx.payer, oracleKey()],
  evmPrizes: (n, authority, pool) => fundEvmPrizes(ctx, realEvmPrizeDeps(ctx, oracleKey), n, authority, pool),
});

// ---- Funding the routes' prizes ----------------------------------------------------------------------------------------

export interface RouteFacts {
  custody: PublicKey;
  kind: "native" | "stake";
  pool: PublicKey;
  mint: PublicKey;
  escrowEnabled: boolean;
  lastFunded: number;
}

/** Reads the custody a route names (a native custody or a stake custody, told apart by the account's discriminator). */
export async function readRoute(core: Core, read: Reader, custody: PublicKey): Promise<RouteFacts | null> {
  const [info] = await read.many([custody]);
  if (!info) return null;
  const disc = (name: string) => Buffer.from((core.coder.accounts as any).accountDiscriminator(name));
  const head = info.data.subarray(0, 8);
  const isNative = head.equals(disc("nativeCustody"));
  const isStake = head.equals(disc("stakeCustody"));
  if (!isNative && !isStake) return null;
  const c: any = core.coder.accounts.decode(isNative ? "nativeCustody" : "stakeCustody", info.data);
  return { custody, kind: isNative ? "native" : "stake", pool: keyOf(c.pool), mint: keyOf(c.mint), escrowEnabled: !!c.route.escrowEnabled, lastFunded: Number(c.route.lastFunded) };
}

/** Routes whose prize must be funded before season `n` can be recorded: escrow on and not yet funded for `n`. */
export const routesToFund = (routes: RouteFacts[], n: number) => routes.filter((r) => r.escrowEnabled && r.lastFunded < n);

async function fundRoute(ctx: Ctx, d: SeasonDeps, route: RouteFacts, n: number, authority: Keypair, pool: PublicKey): Promise<boolean> {
  const subject = `season=${n}`;
  const what = `fund_season_prize (${route.kind} ${shortKey(route.custody)})`;
  const r = await act(ctx, "season", subject, what, async () => {
    const ixs = [];
    if (route.kind === "stake") {
      const [info] = await d.read.many([route.pool]);
      if (info && poolIsStale(info, await d.epoch())) ixs.push(updateStakePoolBalanceIx(route.pool, info));
      const price: any = await ctx.core.account.onchainPrice.fetch(pda("onchain_price", route.mint.toBuffer()));
      ixs.push(await fundSeasonPrizeStakeIx(ctx.core, { authority: authority.publicKey, season: n, custody: route.custody, mint: route.mint, stakePool: route.pool, priceFeed: keyOf(price.feed), poolAccount: pool, prizeSource: prizeSourceOf(route.custody, n) }));
    } else {
      ixs.push(await fundSeasonPrizeNativeIx(ctx.core, { authority: authority.publicKey, season: n, custody: route.custody, pool: route.pool, priceFeed: pda("price", SIM_SOL_MINT.toBuffer()), poolAccount: pool, prizeSource: prizeSourceOf(route.custody, n) }));
    }
    return d.send(ixs, { units: 400_000, signers: extraSigner(ctx, authority) });
  });
  return r.ok;
}

// ---- Recording and paying ----------------------------------------------------------------------------------------------

/** The Pool's overflow record of each route for Season `n` (it may not exist). */
export const routeRecordsOf = (pool: PublicKey, n: number, routes: PublicKey[]): PublicKey[] => routes.map((r) => overflowAddress(pool, OVERFLOW_ROUTE, routeOverflowId(n, r)));

/**
 * `record_season` refuses while a route's prize waits in the Pool's overflow record (the budget is read from the Pool's stores),
 * so claim those records first. True once none holds Gemas.
 */
export async function claimRouteRecords(ctx: Ctx, d: SeasonDeps, n: number, pool: PublicKey, routes: PublicKey[]): Promise<{ clear: boolean; actions: number }> {
  let actions = 0;
  for (let round = 0; round < 8; round++) {
    const addresses = routeRecordsOf(pool, n, routes);
    const infos = await d.read.many(addresses);
    const waiting = infos.flatMap((info, i) => (info && info.data.length > OVERFLOW_STORE_AT ? [overflowRowOf(addresses[i], info.data)] : [])).filter((row) => row.lines.length > 0);
    if (!waiting.length) return { clear: true, actions };
    let sent = 0;
    for (const row of waiting) sent += await claimRecord(ctx, d, row, `season=${n} route record ${shortKey(row.address)}`);
    actions += sent;
    if (!sent) break;
  }
  log("season", `season=${n}`, "WAIT the Pool's route prize still sits in an overflow record (no room in the Pool's stores yet): record_season waits");
  return { clear: false, actions };
}

async function record(ctx: Ctx, d: SeasonDeps, n: number, table: Standing[], authority: Keypair, pool: PublicKey, routes: PublicKey[]): Promise<boolean> {
  const what = `record_season (${table.length} ranked: ${table.map((t) => `${shortKey(t.account)} ${t.points}`).join(", ")})`;
  const r = await act(ctx, "season", `season=${n}`, what, async () => {
    const ix = await recordSeasonIx(ctx.core, { authority: authority.publicKey, number: n, points: table.map((t) => BigInt(t.points)), poolAccount: pool, ranked: table.map((t) => new PublicKey(t.account)), routes, routeRecords: routeRecordsOf(pool, n, routes) });
    return d.send([ix], { units: 400_000, signers: extraSigner(ctx, authority) });
  });
  return r.ok;
}

/** Slots a winner's Account needs for one rank's prize: one line per budget line, held in basket or spill. */
export const slotsNeeded = (rec: SeasonRecord, rank: number) => rec.lines.filter((l) => rankShare(l, rank) > 0n).length;

async function payBatch(ctx: Ctx, d: SeasonDeps, rec: SeasonRecord, steps: PayStep[], authority: Keypair, pool: PublicKey): Promise<boolean> {
  const subject = `season=${rec.number}`;
  const label = steps.map((s) => `rank ${s.rank + 1}/line ${s.line + 1}`).join(", ");
  const r = await act(ctx, "season", subject, `pay_season_rank ${label}`, async () => {
    const ixs = [];
    // A prize line needs a slot in the winner's basket or spill: make one before the payment, never fail for want of it.
    const done = new Set<number>();
    // Ranks whose winner's stores are at the maximum: they cannot grow, so the prize goes to an overflow record.
    const atMaximum = new Set<number>();
    for (const s of steps) {
      if (done.has(s.rank)) continue;
      done.add(s.rank);
      const winner = rec.winners[s.rank];
      const [b, sp] = await d.read.many([basketOf(winner), spillOf(winner)]);
      if (!b || !sp) continue;
      const spill = decodeStore(sp.data);
      const room = slack(decodeStore(b.data), spill);
      const need = slotsNeeded(rec, s.rank);
      if (room >= need) continue;
      if (spill.capacity + (need - room) > MAX_STORE_LINES) atMaximum.add(s.rank);
      else ixs.push(await growStoreIx(ctx.core, { payer: ctx.payer.publicKey, account: winner, which: "spill", extra: need - room }));
    }
    for (const s of steps) {
      const winner = rec.winners[s.rank];
      // the record and the system program: the payout makes the record in the same transaction, the authority pays its rent
      const remaining = atMaximum.has(s.rank) ? [meta(overflowAddress(winner, OVERFLOW_SEASON, seasonOverflowId(rec.number, s.rank, s.line))), meta(SystemProgram.programId, false)] : [];
      ixs.push(await paySeasonRankIx(ctx.core, { authority: authority.publicKey, season: seasonAddress(rec.number), poolAccount: pool, winnerAccount: winner, prizeSource: rec.lines[s.line].source, rank: s.rank, line: s.line, remaining }));
    }
    return d.send(ixs, { units: 300_000 + 100_000 * steps.length, signers: extraSigner(ctx, authority) });
  });
  return r.ok;
}

/** Splits `items` into groups of at most `n`. */
export const groupsOf = <T>(items: T[], n: number): T[][] => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, (i + 1) * n));

/**
 * Job 7: Leaderboard seasons (spec "Season order"). For a season that ended (plus a grace period): fund the prize of every
 * route with its escrow on, record the ranking from core's `MatchWon` events with `record_season` (which freezes the
 * budget), then, once the 48-hour window has passed (ADR 0012), pay every unpaid, unvoided rank line by line
 * with `pay_season_rank`, and finally `close_season`. Signed by the Season keeper the Economy settings name (the keeper
 * payer or the oracle key, whichever the settings point at). Every step is idempotent: the chain says what is left.
 */
export async function seasonJob(ctx: Ctx, d: SeasonDeps = realSeasonDeps(ctx)): Promise<number> {
  const config: any = await ctx.core.account.config.fetch(pda("config"));
  const pool = keyOf(config.poolAccount);
  if (pool.equals(PublicKey.default)) {
    log("season", "-", "leaderboard not set up (Config has no pool): nothing to do");
    return 0;
  }
  const economy: any = await ctx.core.account.economyConfig.fetchNullable(economyAddress);
  if (!economy) {
    log("season", "-", "SKIP: the Economy settings do not exist yet (set_economy)");
    return 0;
  }
  const authority = seasonSigner(keyOf(economy.seasonKeeper), d.candidates());
  if (!authority) {
    log("season", "-", `SKIP: this keeper holds neither its payer nor the oracle key as the Season keeper ${shortKey(keyOf(economy.seasonKeeper))}`);
    return 0;
  }
  const routeKeys = (economy.routes as PublicKey[]).map(keyOf).filter((k) => !k.equals(PublicKey.default));
  let actions = 0;
  for (const n of seasonsToCheck(ctx.now)) {
    const subject = `season=${n}`;
    let rec = await readSeason(ctx.core, n);
    if (!rec && (await d.read.many([seasonAddress(n)]))[0]) {
      log("season", subject, "SKIP: an old-layout Season record exists (paid by the earlier program)");
      continue;
    }
    if (!rec) {
      if (Date.now() - (emptyAt.get(n) ?? 0) < EMPTY_RECHECK_MS) continue;
      const table = topRanks(await d.wins(n));
      if (!table.length) {
        emptyAt.set(n, Date.now());
        log("season", subject, "no wins: nothing to rank, the pool carries over");
        continue;
      }
      const routes = (await Promise.all(routeKeys.map((k) => readRoute(ctx.core, d.read, k)))).filter((r): r is RouteFacts => !!r);
      let funded = true;
      for (const route of routesToFund(routes, n)) {
        if (await fundRoute(ctx, d, route, n, authority, pool)) actions++;
        else funded = false;
      }
      if (!funded) continue;
      // The Pool's share of ETH and HYPE yield. record_season does not wait for these routes: a prize funded later rolls into a later Season.
      if (d.evmPrizes) actions += await d.evmPrizes(n, authority, pool).catch((e) => (log("season", subject, `WARN EVM prizes: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 160)}`), 0));
      const claimed = await claimRouteRecords(ctx, d, n, pool, routeKeys);
      actions += claimed.actions;
      if (!claimed.clear) continue;
      if (!(await record(ctx, d, n, table, authority, pool, routeKeys))) continue;
      actions++;
      rec = await readSeason(ctx.core, n);
      if (!rec) continue;
    }
    const plan = payPlan(rec, ctx.now);
    if (plan.kind === "done") continue;
    if (plan.kind === "wait") {
      log("season", subject, `${rec.count} ranked, payout window open until ${new Date(plan.until * 1000).toISOString()}: the admin can still void a rank`);
      continue;
    }
    if (plan.kind === "close") {
      const r = await act(ctx, "season", subject, "close_season (every rank paid or voided)", async () => d.send([await closeSeasonIx(ctx.core, { season: seasonAddress(n) })], {}));
      actions += +r.ok;
      continue;
    }
    let paid = 0;
    for (const group of groupsOf(plan.steps, STEPS_PER_TX)) {
      if (!(await payBatch(ctx, d, rec, group, authority, pool))) break;
      paid += group.length;
    }
    actions += paid;
    log("season", subject, `${rec.count} ranked, ${paid} of ${plan.steps.length} payment step(s) sent this pass`);
  }
  return actions;
}

export { PAYOUT_WINDOW_SECS, seasonStart };
