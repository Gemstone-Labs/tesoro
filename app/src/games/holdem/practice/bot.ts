/**
 * The practice opponent: estimates its equity against a random hand by sampling run-outs, then
 * bets for value, calls on price, and bluffs now and then. Only ever picks a legal action.
 */
import { NO_CARD, call, check, fold, raise, type Action, type Table } from "../chain";
import { legalMoves } from "../rules";
import { eval7 } from "./eval";

/** Share of the pot this hand wins against one random hand, from `samples` random run-outs. */
export function equity(hole: [number, number], board: number[], samples = 300, random: () => number = Math.random): number {
  const seen = board.filter((c) => c < 52);
  const used = new Set([...hole, ...seen]);
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  const need = 2 + (5 - seen.length);
  let won = 0;
  for (let s = 0; s < samples; s++) {
    // Partial Fisher–Yates: the first `need` cards are a uniform draw.
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(random() * (rest.length - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const full = [...seen, ...rest.slice(2, need)];
    const mine = eval7([...hole, ...full]);
    const theirs = eval7([rest[0], rest[1], ...full]);
    won += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
  }
  return won / samples;
}

/** The bot's decision at `seat`, with `hole` its own cards. */
export function botAction(t: Table, seat: number, hole: [number, number], random: () => number = Math.random): Action {
  const lg = legalMoves(t, seat);
  const board = t.board.filter((c) => c !== NO_CARD);
  const e = equity(hole, board, 300, random);
  const pot = Number(t.pot);
  const toCall = Number(lg.toCall);
  const current = Number(t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
  const facing = toCall > 0;
  const roll = random();

  const raiseTo = (fraction: number): Action => {
    const target = BigInt(Math.round(current + (pot + toCall) * fraction));
    const to = target < lg.minTo ? lg.minTo : target > lg.maxTo ? lg.maxTo : target;
    return raise(to);
  };
  const passive = (): Action => (facing ? call() : check());

  if (e > 0.78 && lg.canRaise && roll < 0.75) return raiseTo(roll < 0.15 ? 2 : 0.8);
  if (e > 0.6) {
    if (lg.canRaise && roll < (facing ? 0.25 : 0.55)) return raiseTo(0.6);
    return passive();
  }
  if (!facing) return lg.canRaise && roll < 0.12 ? raiseTo(0.5) : check();
  // Facing a bet with a middling or weak hand: call on price, bluff-raise rarely.
  const price = toCall / (pot + toCall);
  if (lg.canRaise && roll < 0.05) return raiseTo(0.75);
  return e >= price + 0.04 ? call() : fold();
}
