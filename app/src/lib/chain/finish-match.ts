import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Finishing a Match once its result is committed: `match_chunk` until the run is done, then `close_match`. Every step is
 * permissionless and idempotent, so the winner's page, the loser's page and the keeper's safety sweep can all send them;
 * whoever is late finds the step already done and moves on.
 */

/** Where a Match stands, as far as finishing it cares. */
export interface Progress {
  stage: "open" | "active" | "settling" | "refunding" | "closed";
  /** The run's cursor: a chunk that landed moves it, so a step that changed nothing is seen. */
  phase: number;
  line: number;
}

export type Planned = { kind: "chunk" | "close"; ix: TransactionInstruction } | { kind: "stalled"; reason: string };

export interface FinishDeps {
  /** The Match as it is now; null once it is closed away. */
  fetch(address: PublicKey): Promise<Progress | null>;
  /** The next step for a Match in this state. */
  plan(progress: Progress, address: PublicKey): Promise<Planned>;
  /** Sends one planned step; resolves with its signature. */
  send(step: { kind: "chunk" | "close"; ix: TransactionInstruction }): Promise<string>;
  /** Most steps one call sends (default 24). */
  maxSteps?: number;
}

export interface FinishResult {
  /** The Match is closed away (this call or another actor closed it). */
  done: boolean;
  /** Where it stopped when not done. */
  stage?: Progress["stage"];
  /** Why it stopped before the end: "no-progress", "step-limit" or the planner's reason. */
  stalled?: string;
  signatures: string[];
}

const same = (a: Progress, b: Progress | null) => !!b && a.stage === b.stage && a.phase === b.phase && a.line === b.line;

/**
 * Sends the steps that finish `address`, as far as they go. A step that fails because another actor got there first (the
 * Match moved on, or is gone) is not an error; a step that fails with the Match unchanged is thrown.
 */
export async function finishMatch(deps: FinishDeps, address: PublicKey): Promise<FinishResult> {
  const signatures: string[] = [];
  const limit = deps.maxSteps ?? 24;
  let now = await deps.fetch(address);
  for (let i = 0; ; i++) {
    if (!now) return { done: true, signatures };
    if (now.stage === "open" || now.stage === "active") return { done: false, stage: now.stage, signatures };
    if (i >= limit) return { done: false, stage: now.stage, stalled: "step-limit", signatures };
    const planned = await deps.plan(now, address);
    if (planned.kind === "stalled") return { done: false, stage: now.stage, stalled: planned.reason, signatures };
    let sent: string | null = null;
    let failure: unknown = null;
    try {
      sent = await deps.send(planned);
    } catch (e) {
      failure = e;
    }
    const after = await deps.fetch(address);
    if (failure && same(now, after)) throw failure;
    if (sent) signatures.push(sent);
    if (!failure && same(now, after)) return { done: false, stage: now.stage, stalled: "no-progress", signatures };
    now = after;
  }
}

/**
 * Runs the Game's `finalize` and then finishes the Match. A `finalize` that fails because the Match already moved past it
 * (another actor finalized, or the Match is closed away) is not an error; one that fails with the Match unmoved is thrown.
 */
export async function finalizeAndFinish(deps: FinishDeps, address: PublicKey, finalize: () => Promise<string | null | undefined>): Promise<FinishResult> {
  const signatures: string[] = [];
  try {
    const sig = await finalize();
    if (sig) signatures.push(sig);
  } catch (e) {
    const after = await deps.fetch(address);
    if (after && (after.stage === "open" || after.stage === "active")) throw e;
  }
  const rest = await finishMatch(deps, address);
  return { ...rest, signatures: [...signatures, ...rest.signatures] };
}

/**
 * Makes a page's "finish this Match" call safe to repeat on every poll: one run at a time, a Match seen finished or stalled
 * is not retried, and a thrown failure is retried a few times and then left to the keeper's safety sweep.
 */
export function createFinisher(run: () => Promise<FinishResult>, maxFailures = 3): () => Promise<FinishResult | null> {
  let settled = false;
  let busy = false;
  let failures = 0;
  return async () => {
    if (settled || busy || failures >= maxFailures) return null;
    busy = true;
    try {
      const r = await run();
      settled = r.done || (!!r.stalled && r.stalled !== "step-limit");
      return r;
    } catch (e) {
      failures += 1;
      console.warn("[finish-match]", e);
      return null;
    } finally {
      busy = false;
    }
  };
}
