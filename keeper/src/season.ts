import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { CONFIG, POOL_ACCOUNT, fetchLeaderboardTerms, fetchSeasonRecord, fetchSeasonWins, seasonPda, seasonWindowPda, type SeasonRecord } from "../../app/src/lib/chain/leaderboard.ts";
import { PRIZE_PLACES, payoutOpensAt, seasonAt, seasonEnd, standings, type Standing, type Win } from "../../app/src/lib/chain/season.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { oracleKey } from "./price.ts";

/** A season is recorded this long after it ends, so settlements that were still landing at the boundary are in. */
const GRACE_SECS = Number(process.env.KEEPER_SEASON_GRACE_SECS ?? 10 * 60);
/** How many finished seasons back the job looks for one that is unrecorded or part paid. */
const LOOKBACK = 4;
/** A season with no wins is looked at again this often (scanning the pool history costs RPC calls). */
const EMPTY_RECHECK_MS = 30 * 60_000;

const emptyAt = new Map<number, number>();

/** Finished seasons the job should look at, oldest first: ended at least `graceSecs` ago, at most `lookback` back. */
export function seasonsToCheck(nowSecs: number, graceSecs = GRACE_SECS, lookback = LOOKBACK): number[] {
  const current = seasonAt(nowSecs);
  const out: number[] = [];
  for (let n = Math.max(1, current - lookback); n < current; n++) if (nowSecs >= seasonEnd(n) + graceSecs) out.push(n);
  return out;
}

/** The ranks that are paid: the top `PRIZE_PLACES` of the table. */
export const topRanks = (wins: Win[]): Standing[] => standings(wins).slice(0, PRIZE_PLACES);

/**
 * What to do with a recorded season at `nowSecs`: the ranks to pay now (unpaid, not voided), or when the payout window
 * ends. Read from the chain every pass, so a restart picks up exactly where it was. `recordedAt` null is a season
 * recorded before the window existed; the program cannot pay those (no window account), so the job leaves them.
 */
export function payPlan(
  rec: { count: number; paidMask: number; voidedMask: number; recordedAt: number | null },
  nowSecs: number,
): { kind: "legacy" } | { kind: "wait"; until: number } | { kind: "pay"; ranks: number[] } {
  if (rec.recordedAt === null) return { kind: "legacy" };
  const until = payoutOpensAt(rec.recordedAt);
  if (nowSecs < until) return { kind: "wait", until };
  const ranks: number[] = [];
  for (let r = 0; r < rec.count; r++) if (!(rec.paidMask & (1 << r)) && !(rec.voidedMask & (1 << r))) ranks.push(r);
  return { kind: "pay", ranks };
}

export interface PoolHolding {
  pubkey: PublicKey;
  source: PublicKey;
  amount: bigint;
}

/**
 * The pool Holdings that pay `amount`, as `pay_season_rank` wants them: non-empty, ascending by Source, each
 * drained but the last. Null when the pool does not hold `amount`.
 */
export function prizeHoldings(holdings: PoolHolding[], amount: bigint): PoolHolding[] | null {
  const sorted = holdings.filter((h) => h.amount > 0n).sort((a, b) => Buffer.compare(a.source.toBuffer(), b.source.toBuffer()));
  const out: PoolHolding[] = [];
  let left = amount;
  for (const h of sorted) {
    if (left === 0n) break;
    out.push(h);
    left -= h.amount < left ? h.amount : left;
  }
  return left === 0n ? out : null;
}

// HoldingState: disc 8, bump 1, account 32, then inner { source 32, is_own 1, amount 8, reserved 8 }.
const HOLDING_ACCOUNT_AT = 9;

async function poolHoldings(ctx: Ctx): Promise<PoolHolding[]> {
  const rows: any[] = await ctx.core.account.holdingState.all([{ memcmp: { offset: HOLDING_ACCOUNT_AT, bytes: POOL_ACCOUNT.toBase58() } }]);
  return rows.map((r) => ({ pubkey: r.publicKey as PublicKey, source: new PublicKey(r.account.inner.source), amount: BigInt(r.account.inner.amount.toString()) }));
}

async function record(ctx: Ctx, n: number, table: Standing[], signer: ReturnType<typeof keypairSigner>): Promise<boolean> {
  const subject = `season=${n}`;
  const what = `record_season (${table.length} ranked: ${table.map((t) => `${shortKey(new PublicKey(t.account))} ${t.points}`).join(", ")})`;
  const r = await act(ctx, "season", subject, what, async () => {
    const ix = await ctx.core.methods
      .recordSeason(n, table.map((t) => new anchor.BN(t.points)))
      .accountsPartial({ authority: signer.publicKey, config: CONFIG, poolAccount: POOL_ACCOUNT, season: seasonPda(n), seasonWindow: seasonWindowPda(n), systemProgram: SystemProgram.programId })
      .remainingAccounts(table.map((t) => ({ pubkey: new PublicKey(t.account), isSigner: false, isWritable: false })))
      .instruction();
    return ctx.bp.sendBase(signer, [ix]);
  });
  return r.ok;
}

async function payRank(ctx: Ctx, rec: SeasonRecord, rank: number, signer: ReturnType<typeof keypairSigner>): Promise<boolean> {
  const winner = new PublicKey(rec.winners[rank]);
  const amount = rec.amounts[rank];
  const subject = `season=${rec.number}`;
  const holdings = amount > 0n ? prizeHoldings(await poolHoldings(ctx), amount) : [];
  if (!holdings) {
    log("season", subject, `WARN rank ${rank + 1}: the pool holds less than ${amount} Gemas in whole Holdings; not paid`);
    return false;
  }
  const what = `pay_season_rank ${rank + 1} -> ${shortKey(winner)} ${amount} Gemas over ${holdings.length} Source(s)`;
  const r = await act(ctx, "season", subject, what, async () => {
    const ixs: TransactionInstruction[] = [];
    const theirs: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    for (const h of holdings) {
      const holding = PublicKey.findProgramAddressSync([Buffer.from("holding"), winner.toBuffer(), h.source.toBuffer()], ctx.core.programId)[0];
      theirs.push({ pubkey: holding, isSigner: false, isWritable: true });
      if (!(await ctx.conn.getAccountInfo(holding))) {
        ixs.push(
          await ctx.core.methods
            .openHolding()
            .accountsPartial({ payer: signer.publicKey, account: winner, source: h.source, holding, systemProgram: SystemProgram.programId })
            .instruction(),
        );
      }
    }
    ixs.push(
      await ctx.core.methods
        .paySeasonRank(rank)
        .accountsPartial({ authority: signer.publicKey, config: CONFIG, season: seasonPda(rec.number), seasonWindow: seasonWindowPda(rec.number), poolAccount: POOL_ACCOUNT, winnerAccount: winner })
        .remainingAccounts([...holdings.map((h) => ({ pubkey: h.pubkey, isSigner: false, isWritable: true })), ...theirs])
        .instruction(),
    );
    return ctx.bp.sendBase(signer, ixs);
  });
  return r.ok;
}

/**
 * Job 7: Leaderboard seasons. For a season that ended (plus a grace period), recomputes the table from the pool's
 * `MatchWon` history and records the top ten with `record_season`, then, once the 48-hour payout window has passed (ADR 0012), pays each unpaid,
 * unvoided rank with `pay_season_rank` (one per transaction; Gemas keep their Source). Signed by the oracle key, which `Config.oracle_authority` allows.
 * Both steps are idempotent: a recorded season is never recomputed, a paid rank never paid twice.
 */
export async function seasonJob(ctx: Ctx): Promise<number> {
  const terms = await fetchLeaderboardTerms(ctx.conn, true);
  if (!terms.recipient) {
    log("season", "-", "leaderboard not set up (Config has no pool): nothing to do");
    return 0;
  }
  const key = oracleKey();
  if (!key) {
    log("season", "-", "SKIP: oracle keypair not found (KEEPER_ORACLE_SECRET_KEY / KEEPER_ORACLE / ~/.config/tesoro/oracle.json)");
    return 0;
  }
  const signer = keypairSigner(key);
  let actions = 0;
  for (const n of seasonsToCheck(ctx.now)) {
    let rec = await fetchSeasonRecord(ctx.conn, n);
    if (!rec) {
      if (Date.now() - (emptyAt.get(n) ?? 0) < EMPTY_RECHECK_MS) continue;
      const table = topRanks(await fetchSeasonWins(ctx.conn, n));
      if (!table.length) {
        emptyAt.set(n, Date.now());
        log("season", `season=${n}`, "no wins: nothing to rank, the pool carries over");
        continue;
      }
      if (!(await record(ctx, n, table, signer))) continue;
      actions++;
      rec = await fetchSeasonRecord(ctx.conn, n);
      if (!rec) continue;
    }
    const plan = payPlan(rec, ctx.now);
    if (plan.kind !== "pay") {
      const why = plan.kind === "wait" ? `payout window open until ${new Date(plan.until * 1000).toISOString()}: the admin can still void a rank` : "recorded before the payout window existed: not paid by the keeper";
      log("season", `season=${n}`, `${rec.count} ranked, pool ${rec.poolTotal} Gemas, ${why}`);
      continue;
    }
    let paid = 0;
    for (const rank of plan.ranks) {
      if (!(await payRank(ctx, rec, rank, signer))) break;
      paid++;
    }
    actions += paid;
    log("season", `season=${n}`, `${rec.count} ranked, pool ${rec.poolTotal} Gemas, ${paid} paid this pass, ${rec.voidedMask.toString(2)} voided mask`);
  }
  return actions;
}
