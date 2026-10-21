/**
 * Counters the relayer's limits and its exit reserve live in. One interface so tests run in memory and production uses
 * Postgres (./supabase-store.ts): a serverless host runs many instances, and a limit that only one of them can see is
 * not a limit.
 */
export interface UsageStore {
  /** Adds `cost` to the window of `key` when that stays within `max`; false (and nothing added) otherwise. */
  take(key: string, cost: number, max: number, windowMs: number, now: number): Promise<boolean>;
  /** Gives back a `take` whose action did not happen. */
  refund(key: string, cost: number, now: number): Promise<void>;
  /** Adds to a counter even over its max (a failure or a cycle that already happened); returns the window total. */
  add(key: string, cost: number, windowMs: number, now: number): Promise<number>;
  /** The window total of `key`. */
  used(key: string, windowMs: number, now: number): Promise<number>;
  /** Holds `lamports` for an obligation. A second hold on the same key changes nothing. True when it was new. */
  hold(key: string, lamports: bigint): Promise<boolean>;
  /** Frees an obligation's hold; returns what it held (0 when it held nothing). */
  release(key: string): Promise<bigint>;
  /** Everything held for exits right now. */
  held(): Promise<bigint>;
}

export class MemoryUsageStore implements UsageStore {
  private readonly windows = new Map<string, { start: number; used: number }>();
  private readonly holds = new Map<string, bigint>();

  private current(key: string, windowMs: number, now: number) {
    const w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      const fresh = { start: now, used: 0 };
      this.windows.set(key, fresh);
      return fresh;
    }
    return w;
  }
  async take(key: string, cost: number, max: number, windowMs: number, now: number) {
    const w = this.current(key, windowMs, now);
    if (w.used + cost > max) return false;
    w.used += cost;
    return true;
  }
  async refund(key: string, cost: number) {
    const w = this.windows.get(key);
    if (w) w.used = Math.max(0, w.used - cost);
  }
  async add(key: string, cost: number, windowMs: number, now: number) {
    const w = this.current(key, windowMs, now);
    w.used += cost;
    return w.used;
  }
  async used(key: string, windowMs: number, now: number) {
    const w = this.windows.get(key);
    return w && now - w.start < windowMs ? w.used : 0;
  }
  async hold(key: string, lamports: bigint) {
    if (this.holds.has(key)) return false;
    this.holds.set(key, lamports);
    return true;
  }
  async release(key: string) {
    const v = this.holds.get(key) ?? 0n;
    this.holds.delete(key);
    return v;
  }
  async held() {
    let sum = 0n;
    for (const v of this.holds.values()) sum += v;
    return sum;
  }
}
