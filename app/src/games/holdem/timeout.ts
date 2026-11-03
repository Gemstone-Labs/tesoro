import { PHASE, STATUS, type Table } from "./chain";

/** Past the on-chain deadline by this much before the page claims, so a slow clock or a last-moment move does not race it. */
export const CLAIM_MARGIN_MS = 3_000;
/** A claim that did not land is tried again no sooner than this. */
export const CLAIM_RETRY_MS = 5_000;

/**
 * Whether this page should send `claim_timeout` now. The program lets anyone claim once the deadline passes; the page only does
 * it for the opponent's turn (a stalled shuffle is either seat's to claim), never against its own Player. A move by the opponent
 * moves `deadline`, so a table read after it is no longer due.
 */
export function timeoutClaimDue(t: Pick<Table, "status" | "phase" | "toAct" | "deadline">, seat: 0 | 1, nowMs: number, lastClaimMs: number): boolean {
  if (t.status !== STATUS.live || t.phase === PHASE.none) return false;
  if (t.phase !== PHASE.shuffle && t.toAct === seat) return false;
  if (nowMs < t.deadline * 1000 + CLAIM_MARGIN_MS) return false;
  return nowMs - lastClaimMs >= CLAIM_RETRY_MS;
}
