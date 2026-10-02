import { FILL, SIDE, type Asset, type Fill } from "./chain";
import { midToUsd } from "./feed";
import type { Lead } from "./math";

export const chips = (n: bigint | number): string => Number(n).toLocaleString("en-US");

/** Signed Chips with a real minus sign, for PnL. */
export function signedChips(n: bigint | number): string {
  const v = Number(n);
  if (v === 0) return "0";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-US")}`;
}

/** USD with the precision the asset warrants (HYPE and SOL show cents, ETH too; everything shows at least 2 decimals). */
export function usd(v: number, asset?: Asset, digitsOverride?: number): string {
  const digits = digitsOverride ?? (asset?.symbol === "ETH" ? 2 : v < 1 ? 4 : 2);
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const usdMid = (mid: bigint, asset?: Asset): string => usd(midToUsd(mid), asset);

export function clock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const sideName = (side: number): string => (side === SIDE.long ? "Long" : side === SIDE.short ? "Short" : "Flat");

/** One line for a fill, in the Player's words. */
export function describeFill(f: Fill, asset?: Asset): string {
  const at = usdMid(f.price, asset);
  const size = `${chips(f.margin)} Chips, ${chips(f.notional)} notional`;
  switch (f.kind) {
    case FILL.open:
      return `Opened ${sideName(f.side).toLowerCase()} at ${at} (${size})`;
    case FILL.close:
      return `Closed ${sideName(f.side).toLowerCase()} at ${at}`;
    case FILL.liquidated:
      return `Liquidated ${sideName(f.side).toLowerCase()} at ${at}`;
    case FILL.final:
      return `Marked ${sideName(f.side).toLowerCase()} at the final price ${at}`;
    default:
      return "Fill";
  }
}

export const kindName = (kind: number): string => ["Open", "Close", "Liquidated", "Final"][kind] ?? "Fill";

/** m:ss since trading opened. */
export const tPlus = (t: number): string => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;

/** "You're ahead" / "You're behind" / "Level", from the public lead. */
export function relativeLead(lead: Lead, seat: 0 | 1): string {
  if (lead === "level") return "Level";
  return (lead === "seat0") === (seat === 0) ? "You're ahead" : "You're behind";
}
