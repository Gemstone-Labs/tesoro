/**
 * Fixed-window counter keyed by string. In-memory: one instance per server process, which is
 * enough for the temporary demo route (a redeploy resets it; the SOL faucet has a global cap too).
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; used: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Consumes `cost` if the key stays within `max` for the current window. */
  take(key: string, cost = 1, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (cost > this.max) return false;
      this.hits.set(key, { start: now, used: cost });
      return true;
    }
    if (entry.used + cost > this.max) return false;
    entry.used += cost;
    return true;
  }

  /** Gives back a previous `take` (the action failed before doing anything). */
  refund(key: string, cost = 1) {
    const entry = this.hits.get(key);
    if (entry) entry.used = Math.max(0, entry.used - cost);
  }
}
