import { fmtGemas } from "../format";
import type { ChainRequest, PlayerRecord } from "./backing";
import { historyRow, shortKey, type HistoryRow } from "./history";
import { backerDelta } from "./ledger";
import type { ChainMatch } from "./read";

/** What anyone may see of a Player's Account: the Matches it played and the Requests it has open. */
export interface PlayerAccount {
  /** A TesoroAccount exists at the address. */
  exists: boolean;
  /** Every Match the Account played, as that Account sees it (seat, Backing), newest first. */
  played: ChainMatch[];
  /** Its live Requests (open, not expired). */
  requests: ChainRequest[];
}

/** A finished Match the Account played. */
export interface PlayedRow extends HistoryRow {
  /** Gemas the Backer of this Match gained (+) or lost (−). Null when the Player put in their own entry. */
  backerDelta: number | null;
}

/** The finished Matches an Account played whose result could be read, newest first. */
export function playedRows(played: ChainMatch[]): PlayedRow[] {
  const rows: PlayedRow[] = [];
  for (const m of played) {
    if (m.seat === null) continue;
    const row = historyRow(m);
    if (!row) continue;
    const decided = row.result === "won" || row.result === "lost";
    const backer = !m.backing ? null : decided ? backerDelta({ ...m, backerSeat: m.seat, shareBps: m.backing.shareBps }) : 0;
    rows.push({ ...row, backerDelta: backer });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export interface PlayerSummary {
  /** Matches with a winner, and how many of them this Player won. */
  record: PlayerRecord;
  /** Draws and refunds: finished, not counted in the record. */
  undecided: number;
  /** Settled Matches whose result could not be read: not counted anywhere. */
  notRead: number;
  /** Gemas this Player gained in wins and lost in losses, after Fees. A backed loss costs the Player nothing. */
  won: number;
  lost: number;
  net: number;
  /** The decided Matches this Player played under a Backing, and what their Backers made of them. */
  backings: {
    matches: number;
    wins: number;
    /** Distinct Backers, and how many of them are ahead over all their Backings of this Player. */
    backers: number;
    ahead: number;
    won: number;
    lost: number;
    net: number;
  };
}

export function playerSummary(played: ChainMatch[]): PlayerSummary {
  const rows = playedRows(played);
  const decided = rows.filter((r) => r.result === "won" || r.result === "lost");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const gains = (xs: number[]) => sum(xs.filter((x) => x > 0));
  const losses = (xs: number[]) => sum(xs.filter((x) => x < 0).map((x) => -x));
  const deltas = decided.map((r) => r.delta);

  const backed = decided.filter((r) => r.backing && r.backerDelta !== null);
  const backerDeltas = backed.map((r) => r.backerDelta as number);
  const perBacker = new Map<string, number>();
  for (const r of backed) perBacker.set(r.backing!.other, (perBacker.get(r.backing!.other) ?? 0) + (r.backerDelta as number));

  const finished = played.filter((m) => m.seat !== null && (m.status === "settled" || m.status === "refunded")).length;
  return {
    record: { matches: decided.length, wins: decided.filter((r) => r.result === "won").length },
    undecided: rows.length - decided.length,
    notRead: finished - rows.length,
    won: gains(deltas),
    lost: losses(deltas),
    net: sum(deltas),
    backings: {
      matches: backed.length,
      wins: backed.filter((r) => r.result === "won").length,
      backers: perBacker.size,
      ahead: [...perBacker.values()].filter((v) => v > 0).length,
      won: gains(backerDeltas),
      lost: losses(backerDeltas),
      net: sum(backerDeltas),
    },
  };
}

/**
 * The Player's Gemas won and lost, added up Match by Match in the order the Matches were opened
 * (a Match id carries its opening time, not its settlement). Draws and refunds move nothing and are left out.
 */
export function runningTotal(rows: PlayedRow[]): { row: PlayedRow; total: number }[] {
  let total = 0;
  return rows
    .filter((r) => r.result === "won" || r.result === "lost")
    .sort((a, b) => a.at - b.at)
    .map((row) => ({ row, total: (total += row.delta) }));
}

/** A signed Gema amount: "+540", "−1,000", "0". */
export function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtGemas(Math.abs(n))}`;
}

/** The Backing of a row with what it did for the Backer. Null for an unbacked Match. */
export function backingLine(r: PlayedRow): string | null {
  if (!r.backing || r.backerDelta === null) return null;
  const backer = shortKey(r.backing.other);
  if (r.result === "lost") return `Backer ${backer} bore the loss · ${signed(r.backerDelta)}`;
  if (r.result === "won") return `Backed by ${backer} · Backer ${signed(r.backerDelta)}`;
  return `Backed by ${backer}`;
}
