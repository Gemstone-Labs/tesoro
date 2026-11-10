import { GAME_SERVER_DOWN } from "../../lib/errors";
import { TeeUnreachableError } from "../../lib/chain/tee-auth";

/** Shown once a step has failed this many times in a row; fewer are usually another page getting there first. */
const QUIET_FAILURES = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
/** The program refuses a commit repeat sooner than its own wait, so a page never sends one more often than this. */
const MIN_GAP_MS: Record<string, number> = { commit: 15_000 };

export const STEP_TROUBLE = "The ride is taking longer than usual to move on. Still trying.";

interface Track {
  failures: number;
  until: number;
  /** The game server's own pause is the reason, not the step. */
  paused: boolean;
}

/**
 * When a page may send a ride step again and what it tells the Player. A failed step waits 1 s, 2 s, 4 s ... up to 15 s; the
 * game server's own pause (a ban or a rate limit) is waited out as it says and is not counted as the step failing.
 * Keys are `<step kind>:<car number>`.
 */
export class StepRetry {
  private tracks = new Map<string, Track>();

  ready(key: string, nowMs: number): boolean {
    return nowMs >= (this.tracks.get(key)?.until ?? 0);
  }

  failed(key: string, error: unknown, nowMs: number): void {
    const t = this.tracks.get(key) ?? { failures: 0, until: 0, paused: false };
    if (error instanceof TeeUnreachableError) {
      this.tracks.set(key, { ...t, until: error.retryAt, paused: true });
      return;
    }
    const failures = t.failures + 1;
    this.tracks.set(key, { failures, until: nowMs + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)), paused: false });
  }

  succeeded(key: string, nowMs: number): void {
    const gap = MIN_GAP_MS[key.split(":")[0]] ?? 0;
    if (gap) this.tracks.set(key, { failures: 0, until: nowMs + gap, paused: false });
    else this.tracks.delete(key);
  }

  /** What to tell the Player about this step, or null while it is fine. */
  trouble(key: string): string | null {
    const t = this.tracks.get(key);
    if (!t) return null;
    if (t.paused) return GAME_SERVER_DOWN;
    return t.failures > QUIET_FAILURES ? STEP_TROUBLE : null;
  }
}
