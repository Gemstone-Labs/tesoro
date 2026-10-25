/**
 * Counters the relayer's limits and its exit reserve live in. One interface so tests run in memory and production uses
 * Postgres (./supabase-store.ts): a serverless host runs many instances, and a limit that only one of them can see is
 * not a limit.
 */
import { randomUUID } from "node:crypto";
import type { CompletionInput, CompletionJournal, CompletionStore } from "./completion.ts";

export interface UsageStore extends CompletionStore {
  /** Adds `cost` to the window of `key` when that stays within `max`; false (and nothing added) otherwise. */
  take(key: string, cost: number, max: number, windowMs: number, now: number): Promise<boolean>;
  /** Gives back a `take` whose action did not happen. */
  refund(key: string, cost: number, now: number): Promise<void>;
  /** Adds to a counter even over its max (a failure or a cycle that already happened); returns the window total. */
  add(key: string, cost: number, windowMs: number, now: number): Promise<number>;
  /** The window total of `key`. */
  used(key: string, windowMs: number, now: number): Promise<number>;
  /** Everything held for exits right now. */
  held(): Promise<bigint>;
}

export class MemoryUsageStore implements UsageStore {
  private readonly windows = new Map<string, { start: number; used: number }>();
  private readonly holds = new Map<string, bigint>();
  private readonly generations = new Map<string, string>();
  private readonly inputs = new Map<string, string>();
  private readonly retried = new Set<string>();
  private readonly journals = new Map<string, CompletionJournal>();

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
    this.generations.set(key, randomUUID());
    return true;
  }
  async release(key: string) {
    const v = this.holds.get(key) ?? 0n;
    this.holds.delete(key);
    this.generations.delete(key);
    return v;
  }
  async held() {
    let sum = 0n;
    for (const v of this.holds.values()) sum += v;
    return sum;
  }

  async prepareCompletion(input: CompletionInput) {
    const old = this.journals.get(input.signature);
    if (old) {
      if (this.inputs.get(input.signature) !== JSON.stringify(input) || old.state === "failed") throw new Error("Conflicting or failed sponsor transaction");
      this.retried.add(input.signature);
      return false;
    }
    const keys = [...new Set([...input.creates, ...input.ensures])];
    for (const key of keys) {
      if (input.creates.includes(key) && this.holds.has(key)) throw new Error("Reservation already exists; reconcile its close before reuse");
      if ([...this.journals.values()].some((j) => j.state === "pending" && [...j.acquired, ...j.closes].some((r) => r.key === key && r.generation === this.generations.get(key)))) throw new Error("Reservation has an unresolved transaction");
    }
    const acquired = [];
    for (const key of keys) {
      if (!this.holds.has(key)) {
        const generation = randomUUID();
        this.holds.set(key, BigInt(input.reserve));
        this.generations.set(key, generation);
        acquired.push({ key, generation });
      }
    }
    const closes = input.closes.flatMap((key) => this.holds.has(key) ? [{ key, generation: this.generations.get(key)! }] : []);
    this.inputs.set(input.signature, JSON.stringify(input));
    this.journals.set(input.signature, { ...input, acquired, closes, state: "pending" });
    return true;
  }

  async finishCompletion(signature: string, success: boolean, preflight = false) {
    const j = this.journals.get(signature);
    if (!j) throw new Error("Unknown sponsor transaction");
    if (j.state !== "pending") return;
    if (preflight && this.retried.has(signature)) return;
    for (const r of success ? j.closes : j.acquired) {
      if (this.generations.get(r.key) === r.generation) {
        this.holds.delete(r.key);
        this.generations.delete(r.key);
      }
    }
    j.state = success ? "succeeded" : "failed";
  }

  async pendingCompletions(limit = 50) {
    const pending = [...this.journals.values()].filter((j) => j.state === "pending").slice(0, limit);
    for (const j of pending) this.retried.add(j.signature);
    return pending;
  }
}
