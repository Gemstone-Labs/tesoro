import { jobs } from "./job-stats.ts";
import type { Runtime } from "./runtime.ts";

export const log = (job: string, subject: string, msg: string) =>
  console.log(`${new Date().toISOString()} ${job.padEnd(7)} ${subject} ${msg}`);

/** A job still running after this no longer holds up the others; it is skipped until it finishes. */
const JOB_LIMIT_MS = Number(process.env.KEEPER_JOB_LIMIT_SECS ?? 120) * 1000;
const running = new Map<string, Promise<void>>();

/** Runs a job unless its previous run is still going; waits at most `limitMs` for it. */
export async function runJob<C>(name: string, job: (c: C) => Promise<number>, ctx: C, limitMs = JOB_LIMIT_MS) {
  if (running.has(name)) return log(name, "-", "SKIP: previous run still going");
  jobs.started(name);
  const run = job(ctx)
    .then(() => jobs.ok(name))
    .catch((e) => {
      const msg = String((e as Error).message ?? e).split("\n")[0].slice(0, 300);
      jobs.fail(name, msg);
      log(name, "-", `ERROR ${msg}`);
    })
    .finally(() => running.delete(name));
  running.set(name, run);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"limit">((r) => (timer = setTimeout(() => r("limit"), limitMs)));
  if ((await Promise.race([run, limit])) === "limit") log(name, "-", `WARN still running after ${limitMs / 1000}s, moving on`);
  clearTimeout(timer);
}

/** Rolling one-hour spend of the keeper payer (fees and rent), so a bug cannot drain it. */
export class Budget {
  private spends: { at: number; lamports: number }[] = [];
  private last: number | null = null;
  constructor(private readonly capLamports: number) {}

  private prune(now = Date.now()) {
    this.spends = this.spends.filter((s) => now - s.at < 3_600_000);
  }
  spentLastHour() {
    this.prune();
    return this.spends.reduce((a, s) => a + s.lamports, 0);
  }
  exhausted() {
    return this.spentLastHour() >= this.capLamports;
  }
  /** Records a known spend (e.g. a LayerZero fee) in the same units as the cap. */
  record(amount: number) {
    this.spends.push({ at: Date.now(), lamports: amount });
  }
  /** Records a balance observation; a drop since the last one counts as spend and is returned. */
  observe(balance: number): number {
    const spent = this.last !== null && balance < this.last ? this.last - balance : 0;
    if (spent) this.spends.push({ at: Date.now(), lamports: spent });
    this.last = balance;
    return spent;
  }
}

export interface Outcome {
  ok: boolean;
  detail: string;
}

/**
 * Runs one on-chain action, logging exactly one line. Refuses when the hourly cap (or the job's `share` of it) is
 * reached or in dry-run mode; failures are logged and returned, never thrown, so one bad Match cannot stop a pass.
 */
export async function act(rt: ActCtx, job: string, subject: string, what: string, fn: () => Promise<string | void>, share?: Budget): Promise<Outcome> {
  if (rt.settings.dryRun) {
    log(job, subject, `DRY-RUN would ${what}`);
    return { ok: true, detail: "dry-run" };
  }
  if (rt.budget.exhausted()) {
    log(job, subject, `SKIP ${what}: hourly spend cap reached (${(rt.budget.spentLastHour() / 1e9).toFixed(4)} SOL)`);
    return { ok: false, detail: "budget" };
  }
  if (share?.exhausted()) {
    log(job, subject, `SKIP ${what}: this job's share of the hourly cap is used (${(share.spentLastHour() / 1e9).toFixed(4)} SOL)`);
    return { ok: false, detail: "budget" };
  }
  try {
    const sig = await fn();
    share?.record(rt.budget.observe(await rt.conn.getBalance(rt.payer.publicKey)));
    log(job, subject, `DONE ${what}${sig ? ` sig=${sig}` : ""}`);
    return { ok: true, detail: sig ?? "" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
    log(job, subject, `FAIL ${what}: ${msg}`);
    return { ok: false, detail: msg };
  }
}

/**
 * `lz`: rolling cap on LayerZero fees paid on Solana.
 */
export type Ctx = Runtime & { budget: Budget; lz: Budget };
/** What `act` needs: lets tests drive it without a full runtime. */
export type ActCtx = Pick<Ctx, "settings" | "budget" | "conn" | "payer">;
