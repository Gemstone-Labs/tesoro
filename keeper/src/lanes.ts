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

/**
 * The Block Burst Matches that still need an operator step: joined and not yet closed on tesoro_core (the account is still
 * there), as `address:stage` lines. A Match changing stage changes the list; the same list for a long time is a stuck Match.
 */
export function burstWork(matches: Pick<SchedMatch, "address" | "inner" | "stage">[], burst: PublicKey = BLOCK_PUZZLE_PROGRAM_ID): string[] {
  return matches
    .filter((m) => m.stage !== "open" && pk(m.inner.game).equals(burst))
    .map((m) => `${m.address.toBase58()}:${m.stage}`)
    .sort();
}

/** The jobs of a fast turn, and what decides when it is worth running them. */
export interface FastJobs {
  /** The Matches on tesoro_core: one list read. */
  scan(ctx: Ctx): Promise<Pick<SchedMatch, "address" | "inner" | "stage">[]>;
  /** What runs when there is Block Burst work, in order. */
  jobs: [string, (c: Ctx) => Promise<number>][];
  /** After the last Block Burst work, the lane keeps running the jobs this long (the Match history is written after the close). */
  hotMs: number;
  /** Work that has not changed for this long is stuck, not moving: the full pass handles it, the lane stops running for it. */
  quietMs: number;
  /** Called on each turn that runs the jobs (the keeper's spend is observed from the balance). */
  observe?(ctx: Ctx): Promise<void>;
  /** Cluster time, seconds. */
  clock(ctx: Ctx): Promise<number>;
}

/** One fast turn. With no Block Burst work (and not just after some) it only reads the Match list. Returns the number of jobs run. */
export class FastLane {
  private hotUntil = 0;
  private work = "";
  private changedAt = 0;
  constructor(private readonly d: FastJobs) {}

  async turn(ctx: Ctx, nowMs = Date.now()): Promise<number> {
    ctx.now = await this.d.clock(ctx);
    const work = burstWork(await this.d.scan(ctx)).join(",");
    if (work !== this.work) {
      this.work = work;
      this.changedAt = nowMs;
    }
    if (work && nowMs - this.changedAt < this.d.quietMs) this.hotUntil = nowMs + this.d.hotMs;
    if (nowMs >= this.hotUntil) return 0;
    await this.d.observe?.(ctx);
    // Untracked: the alerts count failures per full pass (five in a row), and a lane turn comes every few seconds.
    for (const [name, job] of this.d.jobs) await runJob(name, job, ctx, undefined, false);
    return this.d.jobs.length;
  }
}
