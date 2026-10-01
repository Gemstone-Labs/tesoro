import { NO_WINNER, PHASE, SPLIT, cardName, type Table } from "./chain";

export interface LogRow {
  who: string;
  text: string;
}
export interface LogStreet {
  name: string;
  rows: LogRow[];
}

/** What the log needs from one table read. */
export type TableRead = Pick<Table, "handNo" | "phase" | "dealer" | "smallBlind" | "bigBlind" | "bets" | "stacks" | "pot" | "toAct" | "board" | "lastHand">;

export interface HandLog {
  hand: number;
  done: boolean;
  streets: LogStreet[];
  /** The read this log was last stepped with. */
  prev: TableRead | null;
}

export const EMPTY_LOG: HandLog = { hand: 0, done: false, streets: [], prev: null };

const STREET_LOG = ["", "Pre-flop", "Flop", "Turn", "River", ""];
const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
const isLive = (phase: number) => phase >= PHASE.preflop && phase <= PHASE.river;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The board cards a street deals: three on the Flop, one on the Turn and the River. */
function dealt(phase: number, board: number[]): string {
  const cards = phase === PHASE.flop ? board.slice(0, 3) : phase === PHASE.turn ? board.slice(3, 4) : phase === PHASE.river ? board.slice(4, 5) : [];
  return cards.map(cardName).join(" ");
}

function openStreet(L: HandLog, phase: number, board: number[]) {
  const cards = dealt(phase, board);
  L.streets.push({ name: STREET_LOG[phase], rows: cards ? [{ who: "Board", text: cards }] : [] });
}

/**
 * The street in `p` ended between two reads (the hand went on to a later street or ended). Whoever
 * owed chips called; with nothing owed, whoever has not acted on this street checked. `added` is
 * what went into the pot after `p`, for the case where a bet and its call both happened unseen.
 */
function closeStreet(street: LogStreet, p: TableRead, added: bigint, who: (i: number) => string) {
  const top = max(p.bets[0], p.bets[1]);
  const actor = p.toAct === 1 ? 1 : 0;
  const other = 1 - actor;
  const owed = top - p.bets[actor];
  const acted = (i: number) => street.rows.some((r) => r.who === who(i));
  if (owed > 0n) {
    const put = min(owed, p.stacks[actor]);
    const allIn = put === p.stacks[actor];
    street.rows.push({ who: who(actor), text: `Call ${chips(put)}${allIn ? " · all-in" : ""}` });
    // Pre-flop the big blind still has the option after the small blind calls: the street closed, so they checked.
    if (p.phase === PHASE.preflop && actor === p.dealer && p.bets[other] === p.bigBlind && !allIn && p.stacks[other] > 0n) {
      street.rows.push({ who: who(other), text: "Check" });
    }
    return;
  }
  if (added > 0n) {
    // A bet and its call, both between two reads: each side put in half.
    const each = added / 2n;
    const to = p.bets[actor] + each;
    street.rows.push({ who: who(actor), text: top === 0n ? `Bet ${chips(to)}` : `Raise to ${chips(to)}` }, { who: who(other), text: `Call ${chips(each)}` });
    return;
  }
  if (p.phase === PHASE.preflop) {
    street.rows.push({ who: who(actor), text: "Check" });
    return;
  }
  // After the flop the big blind acts first. If `actor` is first, both checked since `p`; if second, the first checked before it.
  const order = actor === 1 - p.dealer ? [actor, other] : [other, actor];
  for (const i of order) if (!acted(i)) street.rows.push({ who: who(i), text: "Check" });
}

/**
 * Steps the hand log with one table read. The table publishes only its current state, so actions
 * are inferred from how bets, stacks and the pot moved between two reads; a poll can merge two
 * actions. Pure, so a repeated read changes nothing.
 */
export function stepHandLog(cur: HandLog, t: TableRead, seat: 0 | 1): HandLog {
  const who = (i: number) => (i === seat ? "You" : "Opponent");
  const p = cur.prev;
  let L: HandLog = { hand: cur.hand, done: cur.done, streets: cur.streets.map((s) => ({ ...s, rows: [...s.rows] })), prev: t };
  const lh = t.lastHand;

  // The hand being logged has ended: record how.
  if (!L.done && L.hand > 0 && lh.handNo === L.hand && lh.result !== NO_WINNER) {
    const last = L.streets[L.streets.length - 1];
    const seen = p && p.handNo === L.hand && isLive(p.phase) ? p : null;
    if (last && seen) {
      // Chips that went into the pot after the last read (uncalled chips already returned).
      const added = lh.pot > seen.pot ? lh.pot - seen.pot : 0n;
      if (!lh.showdown && lh.result !== SPLIT) {
        const winner = lh.result;
        if (added > 0n && seen.toAct === winner) {
          const to = seen.bets[winner] + added;
          last.rows.push({ who: who(winner), text: max(seen.bets[0], seen.bets[1]) === 0n ? `Bet ${chips(to)}` : `Raise to ${chips(to)}` });
        }
        last.rows.push({ who: who(1 - winner), text: "Fold" });
      } else {
        closeStreet(last, seen, added, who);
        // An all-in before the River: the rest of the board was dealt with no more betting.
        for (let ph = seen.phase + 1; ph <= PHASE.river; ph++) openStreet(L, ph, lh.board);
        L.streets[L.streets.length - 1].rows.push({ who: "Both", text: "Showdown" });
      }
    } else if (last) {
      if (lh.showdown) last.rows.push({ who: "Both", text: "Showdown" });
      else if (lh.result !== SPLIT) last.rows.push({ who: who(1 - lh.result), text: "Fold" });
    }
    L.done = true;
  }

  if (!isLive(t.phase)) return L;
  if (L.hand !== t.handNo) {
    L = { hand: t.handNo, done: false, streets: [], prev: t };
    openStreet(L, t.phase, t.board);
    if (t.phase === PHASE.preflop) {
      L.streets[0].rows.push({ who: who(t.dealer), text: `Small blind ${chips(t.smallBlind)}` }, { who: who(1 - t.dealer), text: `Big blind ${chips(t.bigBlind)}` });
    }
    return L;
  }
  if (!p || p.handNo !== t.handNo || !isLive(p.phase)) return L;

  let before: [bigint, bigint] = p.bets;
  if (p.phase !== t.phase) {
    // Chips put in since `p`, less what is already bet on the new street.
    const added = t.pot - p.pot - t.bets[0] - t.bets[1];
    closeStreet(L.streets[L.streets.length - 1], p, added > 0n ? added : 0n, who);
    // Every street dealt since `p`, including any the reads skipped.
    for (let ph = p.phase + 1; ph <= t.phase; ph++) openStreet(L, ph, t.board);
    before = [0n, 0n];
  }
  let top = max(before[0], before[1]);
  // When both bets moved between two reads, the smaller one came first.
  const order = t.bets[1] < t.bets[0] ? [1, 0] : [0, 1];
  for (const i of order) {
    const nb = t.bets[i];
    if (nb <= before[i]) continue;
    const allIn = t.stacks[i] === 0n;
    const text = nb <= top ? `Call ${chips(nb - before[i])}` : top === 0n ? `Bet ${chips(nb)}` : `Raise to ${chips(nb)}`;
    L.streets[L.streets.length - 1].rows.push({ who: who(i), text: allIn ? `${text} · all-in` : text });
    top = max(top, nb);
  }
  return L;
}
