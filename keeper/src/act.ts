import type { Runtime } from "./runtime.ts";

export const log = (job: string, subject: string, msg: string) =>
  console.log(`${new Date().toISOString()} ${job.padEnd(7)} ${subject} ${msg}`);

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
  /** Records a balance observation; a drop since the last one counts as spend. */
  observe(balance: number) {
    if (this.last !== null && balance < this.last) this.spends.push({ at: Date.now(), lamports: this.last - balance });
    this.last = balance;
  }
}

export interface Outcome {
  ok: boolean;
  detail: string;
}

/**
 * Runs one on-chain action, logging exactly one line. Refuses when the hourly cap is reached or in
 * dry-run mode; failures are logged and returned, never thrown, so one bad Match cannot stop a pass.
 */
export async function act(rt: Ctx, job: string, subject: string, what: string, fn: () => Promise<string | void>): Promise<Outcome> {
  if (rt.settings.dryRun) {
    log(job, subject, `DRY-RUN would ${what}`);
    return { ok: true, detail: "dry-run" };
  }
  if (rt.budget.exhausted()) {
    log(job, subject, `SKIP ${what}: hourly spend cap reached (${(rt.budget.spentLastHour() / 1e9).toFixed(4)} SOL)`);
    return { ok: false, detail: "budget" };
  }
  try {
    const sig = await fn();
    rt.budget.observe(await rt.conn.getBalance(rt.payer.publicKey));
    log(job, subject, `DONE ${what}${sig ? ` sig=${sig}` : ""}`);
    return { ok: true, detail: sig ?? "" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
    log(job, subject, `FAIL ${what}: ${msg}`);
    return { ok: false, detail: msg };
  }
}

/** `lz`: rolling cap on LayerZero fees paid on Solana; `eth`: rolling cap on the fees paid on Hoodi, in gwei. */
export type Ctx = Runtime & { budget: Budget; lz: Budget; eth: Budget };
