import type { ChainMatch } from "@/lib/chain/read";
import { canFinalizeTable, slotOf, type Assignment, type Table } from "./chain";

/**
 * The Match page's answer when the core Match account is gone, the history has no row yet (it is written after the webhook finalizes
 * the transaction) and the page last saw the Match active. The committed table on base then says how it ended: a result in the
 * ring is a settled Match, a table that moved past the epoch without running it is a refund. Null when base does not say yet.
 */
export function closedWhileSeen(known: ChainMatch | null, base: Table | null, a: Assignment | null, nowS: number): ChainMatch | null {
  if (!known || known.status !== "active" || !base || !a || !canFinalizeTable(base, a, nowS)) return null;
  return { ...known, status: slotOf(base, a.tesoroMatch, a.epoch) ? "settled" : "refunded", running: null };
}
