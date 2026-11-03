/**
 * Dead-keeper monitor. After each run the keeper pings a URL (healthchecks.io style); an external monitor mails the
 * founders when the pings stop. `/fail` is appended for a run that failed. A ping never throws and never stops a run.
 */
export const HEARTBEAT_EVERY_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 10_000;

export async function pingHeartbeat(url: string, outcome: "ok" | "fail", fetchFn: typeof fetch = fetch, timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  const target = outcome === "ok" ? url : `${url.replace(/\/+$/, "")}/fail`;
  try {
    const res = await fetchFn(target, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export class Heartbeat {
  private lastOkAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly url: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.url !== undefined;
  }

  /** Ping now (after a run). */
  async ping(outcome: "ok" | "fail", now = Date.now()): Promise<boolean> {
    if (!this.url) return false;
    const sent = await pingHeartbeat(this.url, outcome, this.fetchFn);
    if (sent && outcome === "ok") this.lastOkAt = now;
    return sent;
  }

  /** Ping only if the last good ping is 5 minutes old: for a long-running loop between runs. */
  async pingIfDue(now = Date.now()): Promise<boolean> {
    if (now - this.lastOkAt < HEARTBEAT_EVERY_MS) return false;
    return this.ping("ok", now);
  }
}

/** The heartbeat read from `envName`; with no URL it is off, and that is logged once here. */
export function heartbeatFrom(envName: string, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch, log: (m: string) => void = console.log): Heartbeat {
  const url = env[envName]?.trim() || undefined;
  if (!url) log(`heartbeat off: ${envName} is not set`);
  return new Heartbeat(url, fetchFn);
}
