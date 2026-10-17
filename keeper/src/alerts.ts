import type { JobStat } from "./job-stats.ts";

/** Who holds a key we watch. `keeper` is the payer; the others are public addresses from env. */
export type Holder = "keeper" | "oracle" | "relayer";

export interface AlertConfig {
  /** A commit pending longer than this is an alert (the 5 min log warning is only a note). */
  commitPendingSecs: number;
  /** A job that threw this many passes in a row. */
  jobFails: number;
  /** A job with no successful run for this long (hung, or always skipped). */
  jobStaleSecs: number;
  /** While a condition lasts, mail a reminder at most this often. */
  reminderMs: number;
  /** Minimum balances, in SOL / ETH / HYPE, per key. Below it is an alert. */
  minSol: Record<Holder, number>;
  minEth: Record<"keeper" | "relayer", number>;
  minHype: Record<"keeper" | "relayer", number>;
  /** Addresses to watch besides the keeper payer (SOL) and the keeper's EVM key. */
  addresses: { oracleSol?: string; relayerSol?: string; keeperEvm?: string; relayerEvm?: string };
}

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function alertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const addr = (name: string) => env[name]?.trim() || undefined;
  return {
    commitPendingSecs: num(env.ALERT_COMMIT_PENDING_SECS, 30 * 60),
    jobFails: num(env.ALERT_JOB_FAILS, 5),
    jobStaleSecs: num(env.ALERT_JOB_STALE_SECS, 30 * 60),
    reminderMs: num(env.ALERT_REMINDER_SECS, 4 * 3600) * 1000,
    minSol: { keeper: num(env.ALERT_MIN_SOL_KEEPER, 0.3), oracle: num(env.ALERT_MIN_SOL_ORACLE, 0.2), relayer: num(env.ALERT_MIN_SOL_RELAYER, 0.3) },
    minEth: { keeper: num(env.ALERT_MIN_ETH_KEEPER, 0.01), relayer: num(env.ALERT_MIN_ETH_RELAYER, 0.01) },
    minHype: { keeper: num(env.ALERT_MIN_HYPE_KEEPER, 0.05), relayer: num(env.ALERT_MIN_HYPE_RELAYER, 0.05) },
    addresses: { oracleSol: addr("ALERT_ORACLE_SOL_ADDRESS"), relayerSol: addr("ALERT_RELAYER_SOL_ADDRESS"), keeperEvm: addr("ALERT_KEEPER_EVM_ADDRESS"), relayerEvm: addr("ALERT_RELAYER_EVM_ADDRESS") },
  };
}

/** A problem that exists right now. `key` identifies it across passes. */
export interface Condition {
  key: string;
  title: string;
  detail: string;
}

export interface BalanceReading {
  key: string;
  label: string;
  unit: string;
  amount: number;
  min: number;
  address: string;
}

const fmt = (n: number) => String(Number(n.toFixed(4)));
const mins = (secs: number) => `${Math.round(secs / 60)} min`;

export function lowBalances(readings: BalanceReading[]): Condition[] {
  return readings
    .filter((r) => r.amount < r.min)
    .map((r) => ({ key: r.key, title: `Low balance: ${r.label}`, detail: `The ${r.label} key holds ${fmt(r.amount)} ${r.unit}, under the ${fmt(r.min)} ${r.unit} minimum. Top it up: ${r.address}` }));
}

export interface Snapshot {
  health: { commitsPending: number; oldestCommitPendingSecs: number };
  jobs: [string, JobStat][];
  balances: BalanceReading[];
}

/** Everything wrong right now, from the health tracker, the job tracker and the balances read this pass. */
export function conditionsOf(s: Snapshot, cfg: AlertConfig, nowMs: number): Condition[] {
  const out: Condition[] = [];
  if (s.health.commitsPending > 0 && s.health.oldestCommitPendingSecs > cfg.commitPendingSecs)
    out.push({ key: "commits", title: "Commits stuck", detail: `${s.health.commitsPending} Match commit(s) pending, the oldest for ${mins(s.health.oldestCommitPendingSecs)} (${s.health.oldestCommitPendingSecs}s): the rollup has not handed the result back. Alert threshold ${mins(cfg.commitPendingSecs)}.` });
  for (const [name, j] of s.jobs) {
    const idleSecs = Math.round((nowMs - j.okAt) / 1000);
    if (j.failedInARow >= cfg.jobFails) out.push({ key: `job:${name}`, title: `Job failing: ${name}`, detail: `The ${name} job failed ${j.failedInARow} passes in a row. Last error: ${j.lastError}` });
    else if (idleSecs > cfg.jobStaleSecs) out.push({ key: `job:${name}`, title: `Job stalled: ${name}`, detail: `The ${name} job has not finished a successful run for ${mins(idleSecs)} (${idleSecs}s). It may be hung or always skipped.` });
  }
  out.push(...lowBalances(s.balances));
  return out;
}

export type AlertKind = "alert" | "reminder" | "recovered";

/** What the app's /api/notify/alert route takes. */
export interface Alert {
  kind: AlertKind;
  key: string;
  title: string;
  detail: string;
  source: string;
}

interface Open {
  title: string;
  detail: string;
  lastSent: number;
  /** The first alert has not reached the server yet. */
  unsent: boolean;
}

/**
 * Turns "what is wrong now" into mails: one alert when a condition starts, a reminder at most every `reminderMs`
 * while it lasts, one "recovered" when it clears. A send that fails is retried on the next tick, not lost.
 * State is in memory: a keeper restart re-announces a condition that is still there.
 */
export class AlertManager {
  private open = new Map<string, Open>();
  private recovering = new Map<string, { title: string; detail: string }>();

  constructor(
    private readonly send: (a: Alert) => Promise<boolean>,
    private readonly reminderMs: number,
    private readonly source = "keeper",
  ) {}

  private async deliver(kind: AlertKind, key: string, c: { title: string; detail: string }): Promise<boolean> {
    try {
      return await this.send({ kind, key, title: c.title, detail: c.detail, source: this.source });
    } catch {
      return false;
    }
  }

  async update(active: Condition[], now = Date.now()): Promise<void> {
    const keys = new Set(active.map((c) => c.key));
    for (const c of active) {
      this.recovering.delete(c.key);
      const o = this.open.get(c.key);
      if (!o) {
        const sent = await this.deliver("alert", c.key, c);
        this.open.set(c.key, { title: c.title, detail: c.detail, lastSent: now, unsent: !sent });
      } else if (o.unsent) {
        o.title = c.title;
        o.detail = c.detail;
        if (await this.deliver("alert", c.key, c)) (o.unsent = false), (o.lastSent = now);
      } else if (now - o.lastSent >= this.reminderMs) {
        o.title = c.title;
        o.detail = c.detail;
        if (await this.deliver("reminder", c.key, c)) o.lastSent = now;
      }
    }
    for (const [key, o] of [...this.open]) {
      if (keys.has(key)) continue;
      this.open.delete(key);
      // Never announced, so there is nothing to recover from.
      if (!o.unsent) this.recovering.set(key, { title: o.title, detail: o.detail });
    }
    for (const [key, c] of [...this.recovering]) {
      if (await this.deliver("recovered", key, c)) this.recovering.delete(key);
    }
  }
}

/** True when the app took the alert (2xx). Never throws: the next tick tries again. */
export async function postAlert(base: string, secret: string, alert: Alert, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(new URL("alert", base).toString(), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(alert), signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface Watch {
  key: string;
  label: string;
  unit: string;
  min: number;
  address: string;
  /** "solana" or an EVM net name. */
  net: string;
}

/** Reads each watched balance; one that cannot be read is skipped (an RPC blip is not a low balance). */
export async function readBalances(watches: Watch[], read: (w: Watch) => Promise<number>): Promise<BalanceReading[]> {
  const out: BalanceReading[] = [];
  for (const w of watches) {
    try {
      const amount = await read(w);
      if (Number.isFinite(amount)) out.push({ key: w.key, label: w.label, unit: w.unit, amount, min: w.min, address: w.address });
    } catch {
      /* keep the last state */
    }
  }
  return out;
}
