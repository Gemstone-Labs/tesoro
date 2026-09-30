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

/**
 * Takes `cost` from every limiter or from none: a rejection gives back only what this call took.
 * Returns the refund for a later failure, or null when any limiter rejected.
 */
export function takeAll(claims: ReadonlyArray<readonly [WindowLimiter, string]>, cost = 1): (() => void) | null {
  const taken: (readonly [WindowLimiter, string])[] = [];
  const refund = () => taken.forEach(([limiter, key]) => limiter.refund(key, cost));
  for (const claim of claims) {
    if (!claim[0].take(claim[1], cost)) {
      refund();
      return null;
    }
    taken.push(claim);
  }
  return refund;
}
