import { FILL, SIDE, type Fill } from "./chain";
import { signedChips } from "./fmt";
import { liquidationMid, type Ledger, type Lead } from "./math";
import type { CalloutTone } from "../fx";

export type Tick = "up" | "down" | "flat";

export function tickDirection(prev: bigint | null, next: bigint | null): Tick {
  if (prev === null || next === null || prev === next) return "flat";
  return next > prev ? "up" : "down";
}

/** How much of the room between entry and liquidation is left: 1 at entry or in profit, 0 at liquidation. 1 when flat. */
export function liquidationDistance(l: Ledger, mid: bigint): number {
  const liq = liquidationMid(l);
  if (l.side === SIDE.flat || liq === null) return 1;
  const entry = Number(l.entry);
  const span = Math.abs(entry - Number(liq));
  if (span === 0) return 0;
  const toward = l.side === SIDE.long ? Number(mid) - Number(liq) : Number(liq) - Number(mid);
  return Math.min(1, Math.max(0, toward / span));
}

export function fillCallout(f: Fill): { text: string; tone: CalloutTone } {
  const up = f.side === SIDE.long;
  switch (f.kind) {
    case FILL.open: {
      const lev = f.margin > 0n ? Number(f.notional / f.margin) : 1;
      return { text: `${up ? "▲ Long" : "▼ Short"} ${lev}x opened`, tone: up ? "up" : "down" };
    }
    case FILL.liquidated:
      return { text: "Liquidated", tone: "warn" };
    case FILL.final:
      return { text: "Marked at the final price", tone: "plain" };
    default:
      return { text: `Closed ${signedChips(f.pnl)} Chips`, tone: "plain" };
  }
}

/** What a change of the coarse lead means for `seat`: took it, lost it, or back to level. */
export function leadChange(prev: Lead | null, next: Lead | null, seat: 0 | 1): "took" | "lost" | "level" | null {
  if (!prev || !next || prev === next) return null;
  if (next === "level") return "level";
  return (next === "seat0") === (seat === 0) ? "took" : "lost";
}

/** Where the duel marker sits, 0 (You end) to 1 (Opponent end): mid when level, leaning to whoever leads. */
export function duelPosition(lead: Lead, seat: 0 | 1): number {
  if (lead === "level") return 0.5;
  return (lead === "seat0") === (seat === 0) ? 0.18 : 0.82;
}
