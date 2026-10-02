/**
 * TypeScript mirror of programs/trading_duel/src/engine.rs: the same integer maths, so the screen
 * can mark a Book against the live price exactly as the program will, and practice runs the real
 * rules. Prices are 1e-8 USD, money is Chips. Everything is bigint and immutable.
 */
import { FILL, RULES, SIDE, type Fill } from "./chain";

export type EngineErrorCode =
  | "overflow"
  | "bad-price"
  | "invalid-leverage"
  | "margin-too-small"
  | "not-enough-chips"
  | "position-open"
  | "no-position"
  | "invalid-side";

export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode) {
    super(
      {
        overflow: "Arithmetic overflow.",
        "bad-price": "The price is unusable.",
        "invalid-leverage": "Leverage must be 1 to 20.",
        "margin-too-small": `Size is below ${RULES.minMargin} Chips.`,
        "not-enough-chips": "Not enough free Chips.",
        "position-open": "A position is already open.",
        "no-position": "No open position.",
        "invalid-side": "Side must be long or short.",
      }[code],
    );
  }
}

/** What a Book holds: the on-chain `Book` decodes to a superset of this. */
export interface Ledger {
  cash: bigint;
  side: number;
  margin: bigint;
  notional: bigint;
  leverage: number;
  /** Fill price the open position was entered at. */
  entry: bigint;
  trades: number;
  liquidations: number;
  fills: Fill[];
}

const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);

export const START_CHIPS = BigInt(RULES.startChips);

export function newLedger(cash: bigint = START_CHIPS): Ledger {
  return { cash, side: SIDE.flat, margin: 0n, notional: 0n, leverage: 0, entry: 0n, trades: 0, liquidations: 0, fills: [] };
}

function u64(v: bigint): bigint {
  if (v < 0n || v > U64_MAX) throw new EngineError("overflow");
  return v;
}

/** Floor division (the program uses `div_euclid` with a positive divisor). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** The oracle price moved against the Player by the spread: buying pays more (rounded up), selling gets less. */
export function fillPrice(mid: bigint, buying: boolean): bigint {
  if (mid <= 0n) throw new EngineError("bad-price");
  const spread = BigInt(RULES.spreadBps);
  return u64(buying ? (mid * (BPS + spread) + (BPS - 1n)) / BPS : (mid * (BPS - spread)) / BPS);
}

/** PnL in Chips at `exit`, rounded down (a loss rounds away from zero). */
export function pnl(side: number, notional: bigint, entry: bigint, exit: bigint): bigint {
  if (entry <= 0n) throw new EngineError("bad-price");
  let diff: bigint;
  if (side === SIDE.long) diff = exit - entry;
  else if (side === SIDE.short) diff = entry - exit;
  else throw new EngineError("invalid-side");
  const v = floorDiv(notional * diff, entry);
  if (v < I64_MIN || v > I64_MAX) throw new EngineError("overflow");
  return v;
}

/** Margin plus PnL if the open position were closed at `mid`, floored at zero. */
export function positionValue(l: Pick<Ledger, "side" | "margin" | "notional" | "entry">, mid: bigint): bigint {
  if (l.side === SIDE.flat) return 0n;
  const exit = fillPrice(mid, l.side === SIDE.short);
  const v = l.margin + pnl(l.side, l.notional, l.entry, exit);
  return v < 0n ? 0n : v;
}

/** Cash plus the open position's value if it were closed at `mid`. */
export function equity(l: Ledger, mid: bigint): bigint {
  return u64(l.cash + positionValue(l, mid));
}

/** Opens a position of `margin` Chips at `leverage`. Only from flat. `t` = seconds since trading opened. */
export function open(l: Ledger, side: number, margin: bigint, leverage: number, mid: bigint, t: number): Ledger {
  if (side !== SIDE.long && side !== SIDE.short) throw new EngineError("invalid-side");
  if (!Number.isInteger(leverage) || leverage < RULES.minLeverage || leverage > RULES.maxLeverage) throw new EngineError("invalid-leverage");
  if (l.side !== SIDE.flat) throw new EngineError("position-open");
  if (margin < BigInt(RULES.minMargin)) throw new EngineError("margin-too-small");
  if (margin > l.cash) throw new EngineError("not-enough-chips");
  const price = fillPrice(mid, side === SIDE.long);
  const notional = u64(margin * BigInt(leverage));
  const next: Ledger = { ...l, cash: l.cash - margin, side, margin, notional, leverage, entry: price, trades: l.trades + 1 };
  const fill: Fill = { t, kind: FILL.open, side, price, notional, margin, pnl: 0n, equity: equity(next, mid) };
  return { ...next, fills: [...l.fills, fill] };
}

/** Closes the open position at `mid` as a `kind` fill. */
export function close(l: Ledger, mid: bigint, t: number, kind: number = FILL.close): { ledger: Ledger; pnl: bigint } {
  if (l.side === SIDE.flat) throw new EngineError("no-position");
  const price = fillPrice(mid, l.side === SIDE.short);
  const p = pnl(l.side, l.notional, l.entry, price);
  const v = l.margin + p;
  const cash = u64(l.cash + (v < 0n ? 0n : v));
  const fill: Fill = { t, kind, side: l.side, price, notional: l.notional, margin: l.margin, pnl: p, equity: cash };
  const ledger: Ledger = {
    ...l,
    cash,
    side: SIDE.flat,
    margin: 0n,
    notional: 0n,
    leverage: 0,
    entry: 0n,
    liquidations: kind === FILL.liquidated ? l.liquidations + 1 : l.liquidations,
    fills: [...l.fills, fill],
  };
  return { ledger, pnl: p };
}

/** Liquidates when margin plus PnL is at or below the maintenance margin (50 bps of notional). */
export function liquidateIfDue(l: Ledger, mid: bigint, t: number): { ledger: Ledger; liquidated: boolean } {
  if (l.side === SIDE.flat) return { ledger: l, liquidated: false };
  const maintenance = (l.notional * BigInt(RULES.maintenanceBps)) / BPS;
  if (positionValue(l, mid) > maintenance) return { ledger: l, liquidated: false };
  return { ledger: close(l, mid, t, FILL.liquidated).ledger, liquidated: true };
}

export type Lead = "level" | "seat0" | "seat1";

/** The coarse lead shown to the opponent and to spectators. */
export function lead(equities: [bigint, bigint]): Lead {
  const [a, b] = equities;
  const diff = a > b ? a - b : b - a;
  if (diff < BigInt(RULES.levelBand)) return "level";
  return a > b ? "seat0" : "seat1";
}

/** Winning seat of two final equities, or `"draw"` when they are equal. */
export function winner(equities: [bigint, bigint]): 0 | 1 | "draw" {
  if (equities[0] === equities[1]) return "draw";
  return equities[0] > equities[1] ? 0 : 1;
}

/** Liquidation price of the open position in oracle (mid) terms, or `null` when flat or not reachable. */
export function liquidationMid(l: Pick<Ledger, "side" | "margin" | "notional" | "entry">): bigint | null {
  if (l.side === SIDE.flat || l.notional === 0n) return null;
  const maintenance = (l.notional * BigInt(RULES.maintenanceBps)) / BPS;
  const room = l.margin - maintenance;
  if (room < 0n) return null;
  const delta = (room * l.entry) / l.notional;
  const spread = BigInt(RULES.spreadBps);
  if (l.side === SIDE.long) {
    const exit = l.entry - delta;
    return exit < 0n ? null : (exit * BPS) / (BPS - spread);
  }
  return ((l.entry + delta) * BPS) / (BPS + spread);
}

/** What a position would look like if opened now: for the order preview. Never throws. */
export function previewOpen(side: number, margin: bigint, leverage: number, mid: bigint): { notional: bigint; entry: bigint; liquidation: bigint | null } | null {
  try {
    const entry = fillPrice(mid, side === SIDE.long);
    const notional = margin * BigInt(leverage);
    return { notional, entry, liquidation: liquidationMid({ side, margin, notional, entry }) };
  } catch {
    return null;
  }
}

/** The error an `open` would raise, or null: lets the screen disable a button with a reason. */
export function openProblem(l: Ledger, margin: bigint, leverage: number): EngineErrorCode | null {
  if (!Number.isInteger(leverage) || leverage < RULES.minLeverage || leverage > RULES.maxLeverage) return "invalid-leverage";
  if (margin < BigInt(RULES.minMargin)) return "margin-too-small";
  if (margin > l.cash) return "not-enough-chips";
  return null;
}

/** Equity as a signed difference from the starting stack, as shown on screen. */
export const pnlOf = (eq: bigint): bigint => eq - START_CHIPS;
