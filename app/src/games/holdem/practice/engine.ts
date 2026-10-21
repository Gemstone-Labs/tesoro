/**
 * Local heads-up No-Limit Hold'em for practice, a port of programs/holdem/src/engine.rs onto the
 * same `Table` shape the chain client decodes, so `HoldemTable` renders it unchanged. No chain, no
 * entropy round: the deck is shuffled locally and dealt when the caller says so. Turbo blinds,
 * like a real Match. No turn clock: practice never times a Player out.
 */
import { PublicKey } from "@solana/web3.js";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, STATUS, type Action, type Table } from "../chain";
import { eval7 } from "./eval";

export const STARTING_CHIPS = 1_500n;
const TURBO_LEVELS: [bigint, bigint][] = [
  [50n, 100n],
  [100n, 200n],
  [200n, 400n],
  [400n, 800n],
  [800n, 1_600n],
];

/** Blinds for a 1-based hand number: turbo, one level per hand, the last level repeats. */
export function blinds(handNo: number): [bigint, bigint] {
  return TURBO_LEVELS[Math.min(Math.max(0, handNo - 1), TURBO_LEVELS.length - 1)];
}

export interface Practice {
  table: Table;
  /** deck[0], deck[2] are seat 0's hole cards, deck[1], deck[3] seat 1's, deck[4..9] the board. */
  deck: number[];
  /** Who has acted since the last bet this street (engine state the decoded Table does not carry). */
  acted: [boolean, boolean];
  /** Hole cards of the hand dealt last; they stay readable after the deck is reshuffled for the next hand. */
  lastHoles: [[number, number], [number, number]] | null;
}

export const holes = (p: Practice): [[number, number], [number, number]] => [
  [p.deck[0], p.deck[2]],
  [p.deck[1], p.deck[3]],
];

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const PLAYERS: [PublicKey, PublicKey] = [key(1), key(2)];

export function shuffled(random: () => number = Math.random): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** A new practice Match, first hand open and waiting for `deal`. */
export function newPractice(now: number, random?: () => number): Practice {
  const table: Table = {
    address: key(3),
    tesoroMatch: key(4),
    players: PLAYERS,
    speed: 1,
    status: STATUS.live,
    finalized: false,
    winner: NO_WINNER,
    startDeadline: 0,
    handNo: 0,
    dealer: 0,
    phase: PHASE.none,
    smallBlind: 0n,
    bigBlind: 0n,
    stacks: [STARTING_CHIPS, STARTING_CHIPS],
    bets: [0n, 0n],
    committed: [0n, 0n],
    pot: 0n,
    toAct: 0,
    lastRaise: 0n,
    board: [NO_CARD, NO_CARD, NO_CARD, NO_CARD, NO_CARD],
    deadline: now,
    missed: [0, 0],
    lastHand: {
      handNo: 0,
      result: NO_WINNER,
      pot: 0n,
      showdown: false,
      shown: [
        [NO_CARD, NO_CARD],
        [NO_CARD, NO_CARD],
      ],
      board: [NO_CARD, NO_CARD, NO_CARD, NO_CARD, NO_CARD],
    },
  };
  const p: Practice = { table, deck: shuffled(random), acted: [false, false], lastHoles: null };
  beginHand(p, now, random);
  return p;
}

function clone(p: Practice): Practice {
  const t = p.table;
  return {
    deck: p.deck,
    acted: [...p.acted],
    lastHoles: p.lastHoles,
    table: {
      ...t,
      stacks: [...t.stacks],
      bets: [...t.bets],
      committed: [...t.committed],
      board: [...t.board],
      missed: [...t.missed],
      lastHand: { ...t.lastHand, shown: [[...t.lastHand.shown[0]], [...t.lastHand.shown[1]]], board: [...t.lastHand.board] },
    },
  };
}

const currentBet = (t: Table) => (t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
const allIn = (t: Table, seat: number) => t.stacks[seat] === 0n;
const syncPot = (t: Table) => {
  t.pot = t.committed[0] + t.committed[1];
};

function post(t: Table, seat: number, amount: bigint) {
  const put = amount < t.stacks[seat] ? amount : t.stacks[seat];
  t.stacks[seat] -= put;
  t.bets[seat] += put;
  t.committed[seat] += put;
  syncPot(t);
}

/** Opens the next hand: rotates the button, posts blinds, waits in `shuffle` for `deal`. */
function beginHand(p: Practice, now: number, random?: () => number) {
  const t = p.table;
  t.handNo += 1;
  t.dealer = t.handNo % 2 === 1 ? 0 : 1;
  [t.smallBlind, t.bigBlind] = blinds(t.handNo);
  t.bets = [0n, 0n];
  t.committed = [0n, 0n];
  t.board = [NO_CARD, NO_CARD, NO_CARD, NO_CARD, NO_CARD];
  t.phase = PHASE.shuffle;
  post(t, t.dealer, t.smallBlind);
  post(t, 1 - t.dealer, t.bigBlind);
  t.lastRaise = t.bigBlind;
  t.toAct = t.dealer;
  t.deadline = now;
  p.deck = shuffled(random);
  p.acted = [false, false];
}

function roundComplete(t: Table, a: [boolean, boolean]): boolean {
  if (allIn(t, 0) || allIn(t, 1)) {
    // A short all-in or a call for less ends betting once the other Player has matched it.
    return ![0, 1].some((i) => allIn(t, i) && !allIn(t, 1 - i) && t.bets[1 - i] < t.bets[i]);
  }
  return a[0] && a[1] && t.bets[0] === t.bets[1];
}

/** The deck is dealt: preflop betting begins. */
export function deal(prev: Practice, now: number, random?: () => number): Practice {
  if (prev.table.status !== STATUS.live || prev.table.phase !== PHASE.shuffle) throw new Error("Not waiting for a deal");
  const p = clone(prev);
  const t = p.table;
  t.phase = PHASE.preflop;
  p.lastHoles = holes(p);
  t.toAct = t.dealer;
  t.deadline = now;
  p.acted = [false, false];
  if (roundComplete(t, p.acted)) finishStreet(p, now, random);
  return p;
}

/** A Player's decision; throws on an illegal one, like the program's `require!`s. */
export function act(prev: Practice, seat: number, action: Action, now: number, random?: () => number): Practice {
  const t0 = prev.table;
  if (t0.status !== STATUS.live) throw new Error("Match is not live");
  if (t0.phase < PHASE.preflop || t0.phase > PHASE.river) throw new Error("Wrong phase");
  if (t0.toAct !== seat) throw new Error("Not your turn");
  const p = clone(prev);
  const t = p.table;
  const a = p.acted;
  const opp = 1 - seat;
  const current = currentBet(t);
  if ("fold" in action) {
    endByFold(p, opp, now, random);
    return p;
  } else if ("check" in action) {
    if (t.bets[seat] !== current) throw new Error("Cannot check");
    a[seat] = true;
  } else if ("call" in action) {
    if (t.bets[seat] >= current) throw new Error("Nothing to call");
    post(t, seat, current - t.bets[seat]);
    a[seat] = true;
  } else {
    const to = BigInt(action.raise.to.toString());
    if (allIn(t, opp)) throw new Error("Opponent is all-in");
    if (to <= current) throw new Error("Raise too small");
    const maxTo = t.bets[seat] + t.stacks[seat];
    if (to > maxTo) throw new Error("Not enough chips");
    const raiseBy = to - current;
    const full = raiseBy >= t.lastRaise;
    if (!full && to !== maxTo) throw new Error("Raise too small");
    post(t, seat, to - t.bets[seat]);
    if (full) t.lastRaise = raiseBy;
    a[opp] = false;
    a[seat] = true;
  }
  if (roundComplete(t, a)) {
    finishStreet(p, now, random);
  } else {
    t.toAct = opp;
    t.deadline = now;
  }
  return p;
}

/** Betting on this street is over: return uncalled chips, then deal on or show down. */
function finishStreet(p: Practice, now: number, random?: () => number) {
  const t = p.table;
  if (t.bets[0] !== t.bets[1]) {
    const [high, low] = t.bets[0] > t.bets[1] ? [0, 1] : [1, 0];
    const excess = t.bets[high] - t.bets[low];
    t.bets[high] -= excess;
    t.committed[high] -= excess;
    t.stacks[high] += excess;
    syncPot(t);
  }
  t.bets = [0n, 0n];
  p.acted = [false, false];
  t.lastRaise = t.bigBlind;
  if (allIn(t, 0) || allIn(t, 1) || t.phase === PHASE.river) {
    revealBoard(p, 5);
    showdown(p, now, random);
    return;
  }
  t.phase += 1;
  revealBoard(p, t.phase === PHASE.flop ? 3 : t.phase + 1);
  // Heads-up: the big blind acts first after the flop.
  t.toAct = 1 - t.dealer;
  t.deadline = now;
}

function revealBoard(p: Practice, count: number) {
  for (let i = 0; i < count; i++) p.table.board[i] = p.deck[4 + i];
}

function endByFold(p: Practice, winner: number, now: number, random?: () => number) {
  const t = p.table;
  t.stacks[winner] += t.pot;
  recordHand(t, winner, false, [
    [NO_CARD, NO_CARD],
    [NO_CARD, NO_CARD],
  ]);
  afterHand(p, now, random);
}

function showdown(p: Practice, now: number, random?: () => number) {
  const t = p.table;
  const h = holes(p);
  const scores = [0, 1].map((s) => eval7([...h[s], ...t.board]));
  const pot = t.pot;
  let result: number;
  if (scores[0] !== scores[1]) {
    result = scores[0] > scores[1] ? 0 : 1;
    t.stacks[result] += pot;
  } else {
    const half = pot / 2n;
    // The odd chip goes to the Player out of position (the big blind).
    t.stacks[0] += half;
    t.stacks[1] += half;
    t.stacks[1 - t.dealer] += pot - half * 2n;
    result = SPLIT;
  }
  recordHand(t, result, true, h);
  afterHand(p, now, random);
}

function recordHand(t: Table, result: number, showdown: boolean, shown: [[number, number], [number, number]]) {
  t.lastHand = { handNo: t.handNo, result, pot: t.pot, showdown, shown, board: [...t.board] };
  t.committed = [0n, 0n];
  t.bets = [0n, 0n];
  syncPot(t);
}

function afterHand(p: Practice, now: number, random?: () => number) {
  const t = p.table;
  if (t.stacks[0] === 0n || t.stacks[1] === 0n) {
    t.status = STATUS.over;
    t.winner = t.stacks[0] === 0n ? 1 : 0;
    t.phase = PHASE.none;
    return;
  }
  beginHand(p, now, random);
}
