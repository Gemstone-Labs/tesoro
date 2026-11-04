import type { ChainMatch } from "./read";

/** What a Game's committed table on base says about a Match: whether it can settle it, and whether its ring holds a result (else it is a refund). */
export interface Committed {
  canFinalize: boolean;
  hasResult: boolean;
}

/**
 * The Match page's answer when the core Match account is gone, the history has no row yet (it is written after the webhook finalizes
 * the transaction) and the page last saw the Match active. The committed table on base then says how it ended: a result in the ring is
 * a settled Match, a table that moved past the epoch without running it is a refund. Null when base does not say yet.
 * The same rule for Hold'em, Trading Duel and Vanguard; each Game passes what its own table says.
 */
export function closedWhileSeen(known: ChainMatch | null, committed: Committed | null): ChainMatch | null {
  if (!known || known.status !== "active" || !committed || !committed.canFinalize) return null;
  return { ...known, status: committed.hasResult ? "settled" : "refunded", running: null };
}
