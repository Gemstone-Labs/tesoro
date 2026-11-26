import { plainError } from "@/lib/errors";

/** A failed read is silent until this many fail in a row: one dropped request is not news. */
const SHOW_AFTER = 2;
const MAX_DELAY_MS = 10_000;

/**
 * How the page's polling reads are doing. The poll backs off while reads fail and the page shows one plain line
 * (never the RPC's raw reply) only while they keep failing; a read that works clears it.
 */
export class ReadHealth {
  private failures = 0;
  private last: unknown = null;

  failed(e: unknown): void {
    this.failures += 1;
    this.last = e;
  }

  succeeded(): void {
    this.failures = 0;
    this.last = null;
  }

  /** The wait before the next read: the normal pace, doubled per failure in a row, capped. */
  delay(base: number): number {
    return Math.min(MAX_DELAY_MS, base * 2 ** Math.min(this.failures, 10));
  }

  problem(): string | null {
    return this.failures >= SHOW_AFTER ? plainError(this.last) : null;
  }
}
