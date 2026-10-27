import type { PublicKey } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { runJob, type Ctx } from "./act.ts";
import { pk } from "./runtime.ts";
import type { SchedMatch } from "./scheduler.ts";

/**
 * The keeper's loop has two lanes. The full pass (every `KEEPER_INTERVAL_SECS`, ~30 s with its own run time) does everything.
 * The fast lane runs between full passes, every `KEEPER_FAST_SECS`, and only for Block Burst: a Match waiting on an operator
 * step (assign a table, begin it, settle it in chunks, close it) otherwise waits up to one whole pass for each. The fast lane
 * is the same jobs on the same Matches, not new rules. In one loop and one thread, so two lanes never send at once.
 */

export type Lane = "full" | "fast";

/** Which lane is due first. A tie goes to the full pass. `fastAt` is `null` when the fast lane is off or paused. */
export function nextTurn(i: { fullAt: number; fastAt: number | null }): Lane {
  return i.fastAt !== null && i.fastAt < i.fullAt ? "fast" : "full";
}

/** A Block Burst Match that still needs an operator step: joined and not yet closed on tesoro_core (its account is still there). */
export function burstWork(matches: Pick<SchedMatch, "inner" | "stage">[], burst: PublicKey = BLOCK_PUZZLE_PROGRAM_ID): boolean {
  return matches.some((m) => m.stage !== "open" && pk(m.inner.game).equals(burst));
}

export interface FastJobs {
  /** The Matches on tesoro_core: one list read. */
  scan(ctx: Ctx): Promise<Pick<SchedMatch, "inner" | "stage">[]>;
  /** What runs when there is Block Burst work, in order. */
  jobs: [string, (c: Ctx) => Promise<number>][];
  /** After the last Block Burst work, the lane keeps running the jobs this long (the Match history is written after the close). */
  hotMs: number;
  /** Cluster time, seconds. */
  clock(ctx: Ctx): Promise<number>;
}

/** One fast turn. With no Block Burst work (and not just after some) it only reads the Match list. Returns the number of jobs run. */
export class FastLane {
  private hotUntil = 0;
  constructor(private readonly d: FastJobs) {}

  async turn(ctx: Ctx, nowMs = Date.now()): Promise<number> {
    ctx.now = await this.d.clock(ctx);
    if (burstWork(await this.d.scan(ctx))) this.hotUntil = nowMs + this.d.hotMs;
    if (nowMs >= this.hotUntil) return 0;
    for (const [name, job] of this.d.jobs) await runJob(name, job, ctx);
    return this.d.jobs.length;
  }
}
