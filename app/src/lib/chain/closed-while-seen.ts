import type { ChainMatch } from "./read";

/** What a Game's committed table on base says about a Match: whether it can settle it, and whether its ring holds a result (else it is a refund). */
export interface Committed {
  canFinalize: boolean;
  /** The ring outcome of the Match's slot (table_kit: 1 opener won, 2 joiner won, 3 draw, 4 no-show); null when the ring holds none (a refund). */
  outcome: number | null;
}

/**
 * The Match page's answer when the core Match account is gone, the history has no row yet (it is written after the webhook finalizes
 * the transaction) and the page last saw the Match active. The committed table on base then says how it ended: a result in the ring is
 * a settled Match (with its winner), a table that moved past the epoch without running it is a refund. Null when base does not say yet.
 * The same rule for Hold'em, Trading Duel and Vanguard; each Game passes what its own table says.
 */
export function closedWhileSeen(known: ChainMatch | null, committed: Committed | null): ChainMatch | null {
  if (!known || known.status !== "active" || !committed || !committed.canFinalize) return null;
  const winner = committed.outcome === 1 ? "opener" : committed.outcome === 2 ? "joiner" : null;
  return { ...known, status: committed.outcome === null ? "refunded" : "settled", running: null, winner };
}
