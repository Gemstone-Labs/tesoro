import { NO_WINNER, PHASE, SPLIT, cardName, type Table } from "./chain";

export type LogWho = "you" | "opponent" | "board" | "both";
export type LogAct = "small-blind" | "big-blind" | "check" | "call" | "bet" | "raise" | "fold" | "board" | "showdown";
export interface LogRow {
  who: LogWho;
  act: LogAct;
  /** Chips put in: the call, the blind, or the total a bet or raise goes to. */
  amount?: bigint;
  allIn?: boolean;
  /** The board cards a street dealt. */
  cards?: number[];
}
export interface LogStreet {
  name: string;
  rows: LogRow[];
}

/** What the log needs from one table read. */
export type TableRead = Pick<Table, "handNo" | "phase" | "dealer" | "smallBlind" | "bigBlind" | "bets" | "stacks" | "pot" | "toAct" | "board" | "lastHand">;

/** A hand that has ended, kept so the log can still show it while later hands play. */
export interface PastHand {
  hand: number;
  streets: LogStreet[];
  end: TableRead["lastHand"] | null;
}

/** How many finished hands the log keeps. */
export const PAST_HANDS = 10;

export interface HandLog {
  hand: number;
  done: boolean;
  streets: LogStreet[];
  /** How the hand ended, once it has. */
  end: TableRead["lastHand"] | null;
  /** Finished hands, newest first. */
  past: PastHand[];
  /** The read this log was last stepped with. */
  prev: TableRead | null;
}

export const EMPTY_LOG: HandLog = { hand: 0, done: false, streets: [], end: null, past: [], prev: null };

const STREET_LOG = ["", "Pre-flop", "Flop", "Turn", "River", ""];
const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");

const ACT_TEXT: Record<LogAct, string> = { "small-blind": "Small blind", "big-blind": "Big blind", check: "Check", call: "Call", bet: "Bet", raise: "Raise to", fold: "Fold", board: "", showdown: "Showdown" };

/** A row in plain words ("Raise to 1,500 · all-in", the board as "As Kd 7h"). */
export function rowText(r: LogRow): string {
  if (r.act === "board") return (r.cards ?? []).map(cardName).join(" ");
  const amount = r.amount !== undefined ? ` ${chips(r.amount)}` : "";
  return `${ACT_TEXT[r.act]}${amount}${r.allIn ? " · all-in" : ""}`;
}
const isLive = (phase: number) => phase >= PHASE.preflop && phase <= PHASE.river;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The board cards a street deals: three on the Flop, one on the Turn and the River. */
function dealt(phase: number, board: number[]): number[] {
  return phase === PHASE.flop ? board.slice(0, 3) : phase === PHASE.turn ? board.slice(3, 4) : phase === PHASE.river ? board.slice(4, 5) : [];
}

function openStreet(L: HandLog, phase: number, board: number[]) {
  const cards = dealt(phase, board);
  L.streets.push({ name: STREET_LOG[phase], rows: cards.length ? [{ who: "board", act: "board", cards }] : [] });
}

/**
 * The street in `p` ended between two reads (the hand went on to a later street or ended). Whoever
 * owed chips called; with nothing owed, whoever has not acted on this street checked. `added` is
 * what went into the pot after `p`, for the case where a bet and its call both happened unseen.
 */
function closeStreet(street: LogStreet, p: TableRead, added: bigint, who: (i: number) => LogWho) {
  const top = max(p.bets[0], p.bets[1]);
  const actor = p.toAct === 1 ? 1 : 0;
  const other = 1 - actor;
  const owed = top - p.bets[actor];
  const acted = (i: number) => street.rows.some((r) => r.who === who(i));
  if (owed > 0n) {
    const put = min(owed, p.stacks[actor]);
    const allIn = put === p.stacks[actor];
    street.rows.push({ who: who(actor), act: "call", amount: put, ...(allIn && { allIn }) });
    // Pre-flop the big blind still has the option after the small blind calls: the street closed, so they checked.
    if (p.phase === PHASE.preflop && actor === p.dealer && p.bets[other] === p.bigBlind && !allIn && p.stacks[other] > 0n) {
      street.rows.push({ who: who(other), act: "check" });
    }
    return;
  }
  if (added > 0n) {
    // A bet and its call, both between two reads: each side put in half.
    const each = added / 2n;
    const to = p.bets[actor] + each;
    street.rows.push({ who: who(actor), act: top === 0n ? "bet" : "raise", amount: to }, { who: who(other), act: "call", amount: each });
    return;
  }
  if (p.phase === PHASE.preflop) {
    street.rows.push({ who: who(actor), act: "check" });
    return;
  }
  // After the flop the big blind acts first. If `actor` is first, both checked since `p`; if second, the first checked before it.
  const order = actor === 1 - p.dealer ? [actor, other] : [other, actor];
  for (const i of order) if (!acted(i)) street.rows.push({ who: who(i), act: "check" });
}

/**
 * Steps the hand log with one table read. The table publishes only its current state, so actions
 * are inferred from how bets, stacks and the pot moved between two reads; a poll can merge two
 * actions. Pure, so a repeated read changes nothing.
 */
export function stepHandLog(cur: HandLog, t: TableRead, seat: 0 | 1): HandLog {
  const who = (i: number): LogWho => (i === seat ? "you" : "opponent");
  const p = cur.prev;
  let L: HandLog = { hand: cur.hand, done: cur.done, streets: cur.streets.map((s) => ({ ...s, rows: [...s.rows] })), end: cur.end, past: cur.past, prev: t };
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
          last.rows.push({ who: who(winner), act: max(seen.bets[0], seen.bets[1]) === 0n ? "bet" : "raise", amount: to });
        }
        last.rows.push({ who: who(1 - winner), act: "fold" });
      } else {
        closeStreet(last, seen, added, who);
        // An all-in before the River: the rest of the board was dealt with no more betting.
        for (let ph = seen.phase + 1; ph <= PHASE.river; ph++) openStreet(L, ph, lh.board);
        L.streets[L.streets.length - 1].rows.push({ who: "both", act: "showdown" });
      }
    } else if (last) {
      if (lh.showdown) last.rows.push({ who: "both", act: "showdown" });
      else if (lh.result !== SPLIT) last.rows.push({ who: who(1 - lh.result), act: "fold" });
    }
    L.done = true;
    L.end = lh;
  }

  if (!isLive(t.phase)) return L;
  if (L.hand !== t.handNo) {
    const past = L.streets.length > 0 ? [{ hand: L.hand, streets: L.streets, end: L.end }, ...L.past].slice(0, PAST_HANDS) : L.past;
    L = { hand: t.handNo, done: false, streets: [], end: null, past, prev: t };
    openStreet(L, t.phase, t.board);
    if (t.phase === PHASE.preflop) {
      L.streets[0].rows.push({ who: who(t.dealer), act: "small-blind", amount: t.smallBlind }, { who: who(1 - t.dealer), act: "big-blind", amount: t.bigBlind });
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
    const row: LogRow = nb <= top ? { who: who(i), act: "call", amount: nb - before[i] } : { who: who(i), act: top === 0n ? "bet" : "raise", amount: nb };
    L.streets[L.streets.length - 1].rows.push(allIn ? { ...row, allIn } : row);
    top = max(top, nb);
  }
  return L;
}
