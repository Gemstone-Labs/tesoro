import { FILL, SIDE } from "../chain";
import { botDecide } from "./bot";
import { EngineError, close, equity, liquidateIfDue, newLedger, open, winner, type Ledger } from "../math";

export interface Final {
  equity: [bigint, bigint];
  winner: 0 | 1 | "draw";
  price: bigint;
}

/** A practice Match against the local bot: seat 0 is you, seat 1 the bot. Pure state, driven by `stepSession`. */
export interface Session {
  startsAt: number;
  endsAt: number;
  me: Ledger;
  bot: Ledger;
  botNextAt: number;
  final: Final | null;
}

export const BOT_EVERY_MS = 2000;

export function newSession(startsAt: number, durationSecs: number): Session {
  return { startsAt, endsAt: startsAt + durationSecs * 1000, me: newLedger(), bot: newLedger(), botNextAt: startsAt + 3000, final: null };
}

const secs = (s: Session, nowMs: number) => Math.max(0, Math.floor((nowMs - s.startsAt) / 1000));

function trading(s: Session, nowMs: number): boolean {
  return !s.final && nowMs >= s.startsAt && nowMs <= s.endsAt;
}

/** Your order. Throws `EngineError` for the same reasons the program refuses. */
export function playerOrder(s: Session, order: { kind: "open"; side: 1 | 2; margin: bigint; leverage: number } | { kind: "close" } | { kind: "flip"; side: 1 | 2; margin: bigint; leverage: number }, mid: bigint, nowMs: number): Session {
  if (!trading(s, nowMs)) throw new EngineError("no-position");
  const t = secs(s, nowMs);
  let me = liquidateIfDue(s.me, mid, t).ledger;
  if (order.kind === "close") {
    if (me.side !== SIDE.flat) me = close(me, mid, t).ledger;
  } else {
    if (order.kind === "flip" && me.side !== SIDE.flat) me = close(me, mid, t).ledger;
    me = open(me, order.side, order.margin, order.leverage, mid, t);
  }
  return { ...s, me };
}

/**
 * One tick of the Match at oracle price `mid`: due liquidations, the bot's occasional move, and the
 * end of the window (open positions close at the final price, higher equity wins, equal is a draw).
 * `prices` is the recent public price history in USD, newest last, which is all the bot sees.
 */
export function stepSession(s: Session, mid: bigint, nowMs: number, rng: () => number, prices: number[]): Session {
  if (s.final || nowMs < s.startsAt) return s;
  const t = secs(s, nowMs);
  let me = liquidateIfDue(s.me, mid, t).ledger;
  let bot = liquidateIfDue(s.bot, mid, t).ledger;
  if (nowMs >= s.endsAt) {
    const t0 = secs(s, s.endsAt);
    if (me.side !== SIDE.flat) me = close(me, mid, t0, FILL.final).ledger;
    if (bot.side !== SIDE.flat) bot = close(bot, mid, t0, FILL.final).ledger;
    const eq: [bigint, bigint] = [me.cash, bot.cash];
    return { ...s, me, bot, final: { equity: eq, winner: winner(eq), price: mid } };
  }
  let botNextAt = s.botNextAt;
  if (nowMs >= botNextAt) {
    botNextAt = nowMs + BOT_EVERY_MS;
    const move = botDecide(bot, prices, mid, rng);
    try {
      if (move?.kind === "open") bot = open(bot, move.side, move.margin, move.leverage, mid, t);
      else if (move?.kind === "close") bot = close(bot, mid, t).ledger;
    } catch {
      // a refused bot order is simply skipped
    }
  }
  return { ...s, me, bot, botNextAt };
}

/** Equities of both sides marked at `mid`. */
export function marked(s: Session, mid: bigint): [bigint, bigint] {
  return [equity(s.me, mid), equity(s.bot, mid)];
}
