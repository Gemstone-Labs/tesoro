import { unplayed, type HistoryRow } from "@/lib/chain/history";

export interface FriendRecord {
  won: number;
  lost: number;
  draws: number;
  /** Newest Match played against this Friend (ms), null when never. */
  last: number | null;
}

/** My record against one Account, from my own history (Matches I played; refunds and Backings left out). */
export function recordAgainst(rows: HistoryRow[], other: string): FriendRecord {
  const r: FriendRecord = { won: 0, lost: 0, draws: 0, last: null };
  for (const row of rows) {
    if (row.role !== "player" || row.opp !== other || unplayed(row.result)) continue;
    if (row.result === "won") r.won++;
    else if (row.result === "lost") r.lost++;
    else r.draws++;
    r.last = Math.max(r.last ?? 0, row.at);
  }
  return r;
}

/** "You 4–2", "You 2–2, 1 draw", or "Never played". */
export function recordText(r: FriendRecord): string {
  if (!r.won && !r.lost && !r.draws) return "Never played";
  return `You ${r.won}–${r.lost}${r.draws ? `, ${r.draws} ${r.draws === 1 ? "draw" : "draws"}` : ""}`;
}

/** Friends I played most recently first, then the newest Friends. */
export function sortFriends<T extends { account: string; since: number }>(friends: T[], records: Map<string, FriendRecord>): T[] {
  return [...friends].sort((a, b) => {
    const la = records.get(a.account)?.last ?? null;
    const lb = records.get(b.account)?.last ?? null;
    if (la !== lb) return (lb ?? -1) - (la ?? -1);
    return b.since - a.since;
  });
}
