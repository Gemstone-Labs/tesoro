/** Statistics for the 5-second-turn latency spike (scripts/turn-latency-spike.ts). */

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const v = [...values].sort((a, b) => a - b);
  const at = (p / 100) * (v.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return v[lo] + (v[hi] - v[lo]) * (at - lo);
}

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(values: number[]): Summary {
  return {
    n: values.length,
    min: percentile(values, 0),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: percentile(values, 100),
  };
}

/** Moves whose block's clock (whole seconds) is past their turn start + the turn length + the grace. */
export function lateRate(moves: { turnTs: number; landedTs: number }[], turnSecs: number, graceSecs: number): { late: number; of: number } {
  return { late: moves.filter((m) => m.landedTs > m.turnTs + turnSecs + graceSecs).length, of: moves.length };
}

/**
 * Where the rollup's whole seconds begin on the local clock, from readings of its clock:
 * a reading can only be late, so the smallest `seenMs - ts * 1000` is the tightest bound.
 */
export function boundaryOffsetMs(samples: { ts: number; seenMs: number }[]): number {
  return Math.min(...samples.map((s) => s.seenMs - s.ts * 1000));
}
