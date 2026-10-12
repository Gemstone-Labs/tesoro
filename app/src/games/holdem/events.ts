import { NO_WINNER, PHASE, SPLIT, type Table } from "./chain";

/** What the table needs to know of one read; the same fields the hand log reads. */
export type TableState = Pick<Table, "handNo" | "phase" | "dealer" | "smallBlind" | "bigBlind" | "bets" | "stacks" | "pot" | "toAct" | "board" | "lastHand">;

export type ActionKind = "check" | "call" | "bet" | "raise" | "fold";

export type TableEvent =
  | { type: "newHand"; handNo: number; dealer: number; smallBlind: bigint; bigBlind: bigint; blindsUp: boolean }
  | { type: "deal" }
  | { type: "action"; seat: number; kind: ActionKind; /** Chips added (call) or the bet to (bet, raise); 0 for check and fold. */ amount: bigint; allIn: boolean }
  | { type: "sweep"; amount: bigint }
  | { type: "street"; street: "flop" | "turn" | "river"; cards: number[] }
  | { type: "result"; winner: number | "split"; how: "fold" | "showdown"; pot: bigint };

const isLive = (phase: number) => phase >= PHASE.preflop && phase <= PHASE.river;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sum = (b: readonly [bigint, bigint]) => b[0] + b[1];

const STREETS = ["", "", "flop", "turn", "river"] as const;
const dealt = (phase: number, board: number[]) => (phase === PHASE.flop ? board.slice(0, 3) : phase === PHASE.turn ? board.slice(3, 4) : board.slice(4, 5));
const streetEvent = (phase: number, board: number[]): TableEvent => ({ type: "street", street: STREETS[phase] as "flop", cards: dealt(phase, board) });

function action(seat: number, kind: ActionKind, amount: bigint, allIn = false): TableEvent {
  return { type: "action", seat, kind, amount, allIn };
}

/**
 * The street in `p` ended between two reads (the hand went on or ended). Whoever owed chips called;
 * with nothing owed, the player to act checked (and, after the flop, the player before them too when
 * they act second). `added` is what went into the pot after `p`, for a bet and its call both unseen.
 */
function closeStreet(p: TableState, added: bigint): TableEvent[] {
  const top = max(p.bets[0], p.bets[1]);
  const actor = p.toAct === 1 ? 1 : 0;
  const other = 1 - actor;
  const owed = top - p.bets[actor];
  if (owed > 0n) {
    const put = min(owed, p.stacks[actor]);
    const allIn = put === p.stacks[actor];
    const out = [action(actor, "call", put, allIn)];
    // Pre-flop the big blind still has the option after the small blind calls: the street closed, so they checked.
    if (p.phase === PHASE.preflop && actor === p.dealer && p.bets[other] === p.bigBlind && !allIn && p.stacks[other] > 0n) out.push(action(other, "check", 0n));
    return out;
  }
  if (added > 0n) {
    // A bet and its call, both between two reads: each side put in half.
    const each = added / 2n;
    return [action(actor, top === 0n ? "bet" : "raise", p.bets[actor] + each), action(other, "call", each)];
  }
  if (p.phase !== PHASE.preflop && actor === 1 - p.dealer) return [action(actor, "check", 0n), action(other, "check", 0n)];
  return [action(actor, "check", 0n)];
}

/** Bets that moved between two reads on the same street; the smaller bet came first. */
function betActions(before: [bigint, bigint], t: TableState): TableEvent[] {
  let top = max(before[0], before[1]);
  const out: TableEvent[] = [];
  for (const i of t.bets[1] < t.bets[0] ? [1, 0] : [0, 1]) {
    const nb = t.bets[i];
    if (nb <= before[i]) continue;
    const allIn = t.stacks[i] === 0n;
    out.push(nb <= top ? action(i, "call", nb - before[i], allIn) : top === 0n ? action(i, "bet", nb, allIn) : action(i, "raise", nb, allIn));
    top = max(top, nb);
  }
  return out;
}

const sweep = (amount: bigint): TableEvent[] => (amount > 0n ? [{ type: "sweep", amount }] : []);

/**
 * What happened between two table reads, in order. The table publishes only its current state, so
 * actions are inferred from how bets, stacks and the pot moved; a poll can merge several reads, in
 * which case the best single description is given and never a wrong one. Pure.
 */
export function diffTable(prev: TableState | null, next: TableState): TableEvent[] {
  if (!prev) return [];
  const out: TableEvent[] = [];
  const lh = next.lastHand;

  // The hand in `prev` ended.
  if (isLive(prev.phase) && lh.handNo === prev.handNo && lh.result !== NO_WINNER) {
    const outside = prev.pot - sum(prev.bets);
    const added = lh.pot > prev.pot ? lh.pot - prev.pot : 0n;
    const split = lh.result === SPLIT;
    if (!lh.showdown && !split) {
      const winner = lh.result;
      if (added > 0n && prev.toAct === winner) {
        out.push(action(winner, max(prev.bets[0], prev.bets[1]) === 0n ? "bet" : "raise", prev.bets[winner] + added));
      }
      out.push(action(1 - winner, "fold", 0n));
    } else {
      out.push(...closeStreet(prev, added));
    }
    out.push(...sweep(lh.pot - outside));
    if (lh.showdown) for (let ph = prev.phase + 1; ph <= PHASE.river; ph++) out.push(streetEvent(ph, lh.board));
    out.push({ type: "result", winner: split ? "split" : lh.result, how: lh.showdown ? "showdown" : "fold", pot: lh.pot });
  } else if (isLive(prev.phase) && isLive(next.phase) && next.handNo === prev.handNo) {
    let before: [bigint, bigint] = prev.bets;
    if (next.phase !== prev.phase) {
      const added = next.pot - prev.pot - sum(next.bets);
      out.push(...closeStreet(prev, added > 0n ? added : 0n));
      out.push(...sweep(next.pot - sum(next.bets) - (prev.pot - sum(prev.bets))));
      for (let ph = prev.phase + 1; ph <= next.phase; ph++) out.push(streetEvent(ph, next.board));
      before = [0n, 0n];
    }
    const moved = betActions(before, next);
    out.push(...moved);
    // A turn passed with no chips: the player to act checked.
    if (!moved.length && next.phase === prev.phase && next.toAct !== prev.toAct) out.push(action(prev.toAct, "check", 0n));
  }

  if (next.handNo > prev.handNo) {
    out.push({ type: "newHand", handNo: next.handNo, dealer: next.dealer, smallBlind: next.smallBlind, bigBlind: next.bigBlind, blindsUp: prev.handNo > 0 && next.bigBlind > prev.bigBlind });
  }
  if (isLive(next.phase) && (!isLive(prev.phase) || next.handNo > prev.handNo)) {
    out.push({ type: "deal" });
    const blinds: [bigint, bigint] = next.dealer === 0 ? [next.smallBlind, next.bigBlind] : [next.bigBlind, next.smallBlind];
    for (let ph = PHASE.flop; ph <= next.phase; ph++) out.push(streetEvent(ph, next.board));
    if (next.phase === PHASE.preflop) out.push(...betActions(blinds, next));
  }
  return out;
}
