import { PublicKey } from "@solana/web3.js";
import { call, check, raise, PHASE, STATUS as HD_STATUS, type Action } from "@/games/holdem/chain";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import { act, deal, newPractice, type Practice } from "@/games/holdem/practice/engine";
import { ASSETS, NO_WINNER, STATUS, type Book, type Duel } from "@/games/trading-duel/chain";
import { COLUMNS, MATCH_SECS, NO_PICK, STEP_PPM, finish, hits, lockAt, newTrack, record, stepFor, type Track } from "@/games/trading-duel/grid";
import { usdToMid } from "@/games/trading-duel/feed";
import type { DuelView } from "@/games/trading-duel/useDuelMatch";
import { backed, match } from "@/lib/chain/fixture";
import type { ChainMatch } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";
import { DEMO_ME } from "../../support/data";
import { demoKey } from "./screen";

export type MatchState = "open" | "active" | "won" | "lost" | "draw" | "refunded" | "spectator";

const FEES = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };
const secs = () => Math.floor(Date.now() / 1000);

/** The signed-in demo Account's Match in a given state, as `fetchMatch` returns it. */
export function chainMatch(game: GameId, state: MatchState, o: { challenge?: boolean; entry?: number; backing?: "player" | "backer" } = {}): ChainMatch {
  const entry = o.entry ?? 1000;
  const base = { ...match(game, entry, state !== "lost", 2, [171, 55], DEMO_ME), fees: FEES };
  const bp = game === "block-puzzle";
  const id = o.challenge ? base.id | 1n : base.id;
  const session = (over: Partial<NonNullable<ChainMatch["session"]>>) =>
    bp ? { settled: false, joined: false, result: "draw" as const, scores: [0, 0] as [number, number], seed: 0n, openerDeadline: secs() + 900, deadline: 0, ...over } : null;
  let m: ChainMatch = { ...base, id, challenge: !!o.challenge };
  if (state === "open") m = { ...m, status: "open", opponent: null, sides: [m.sides[0], null], winner: null, deadline: secs() + 3600, session: session({}) };
  if (state === "active") m = { ...m, status: "active", winner: null, deadline: secs() + 3600, session: session({ joined: true, deadline: secs() + 900 }) };
  if (state === "refunded") m = { ...m, status: "refunded", winner: null, session: session({ joined: true }) };
  if (state === "draw") m = { ...m, session: session({ settled: true, joined: true, result: "draw", scores: [118, 118] }), winner: null, status: bp ? "settled" : "refunded" };
  if (state === "won" || state === "lost") m = { ...m, id };
  if (state === "spectator") {
    const [a, b] = [demoKey(41), demoKey(42)];
    m = { ...m, status: "settled", seat: null, opponent: a, sides: [{ player: a, funder: a, shareBps: 0 }, { player: b, funder: b, shareBps: 0 }] };
  }
  if (o.backing) m = backed(m, demoKey(801), 4000, o.backing === "backer");
  return m;
}

const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A practice hand played through `steps` (seat, action) pairs on a seeded deck, as a live Hold'em table. */
function hand(seed: number, steps: [number, Action][]): Practice {
  const r = rng(seed);
  const now = secs();
  let p = deal(newPractice(now, r), now, r);
  for (const [seat, a] of steps) p = act(p, seat, a, now, r);
  return p;
}

export function holdemLive(kind: "preflop" | "flop" | "facing-bet"): Partial<HoldemView> {
  const steps: [number, Action][] =
    kind === "preflop" ? [] : kind === "flop" ? [[0, call()], [1, check()], [1, check()]] : [[0, call()], [1, check()], [1, raise(300)]];
  const p = hand(5, steps);
  const t = p.table;
  const playing = t.phase >= PHASE.preflop && t.phase <= PHASE.river;
  return { stage: "live", table: t, seat: 0, hole: p.lastHoles ? { handNo: playing ? t.handNo : t.lastHand.handNo, cards: p.lastHoles[0] } : null };
}

export function holdemOver(): Partial<HoldemView> {
  const p = hand(5, [[0, raise(1500)], [1, call()]]);
  return { stage: "closing", note: "Saving the result", table: { ...p.table, status: HD_STATUS.over } };
}

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

function book(seat: 0 | 1, picks: number[]): Book {
  return { address: key(60 + seat), duel: key(50), player: key(70 + seat), seat, picks, pickCount: picks.filter((r) => r !== NO_PICK).length };
}

const ANCHOR = usdToMid(142.5);
const STEP = stepFor(ANCHOR, STEP_PPM.SOL);
const blank = () => Array.from({ length: COLUMNS }, () => NO_PICK);

/** The line `t` seconds in: a slow swell around the start price, one sample a second. */
function trackAt(t: number): Track {
  let tr = record(newTrack(), 0, ANCHOR);
  const price = (sec: number) => ANCHOR + BigInt(Math.round((Math.sin(sec / 9) * 1.6 + Math.sin(sec / 3.1) * 0.5) * Number(STEP)));
  for (let sec = 1; sec < Math.min(t, MATCH_SECS); sec++) tr = record(tr, sec, price(sec));
  return t >= MATCH_SECS ? finish(tr) : tr;
}

/** Everyone's picks `t` seconds in: yours for the columns you filled, the opponent's only for locked columns. */
function picksAt(t: number, mine: number[], theirs: number[]) {
  const lockedOnly = (p: number[]) => p.map((r, c) => (t >= lockAt(c) ? r : NO_PICK));
  return { mine: mine.map((r, c) => (t < MATCH_SECS || c < COLUMNS ? r : NO_PICK)), revealed: [lockedOnly(mine), lockedOnly(theirs)] as [number[], number[]] };
}

const MINE = [4, 5, 4, 3, 3, 4, 5, 5, 4, 3, 4, 4];
const THEIRS = [3, 4, 6, 3, 5, 2, 5, 4, 4, 2, 3, 5];

function gridDuel(t: number, over: Partial<Duel> = {}): { duel: Duel; mine: number[] } {
  const track = trackAt(t);
  const { mine, revealed } = picksAt(t, MINE.map((r, c) => (t < 20 + 10 * c && c > 2 + Math.floor(t / 10) ? NO_PICK : r)), THEIRS);
  const startsAt = secs() - Math.floor(t);
  const points = (picks: number[]) => picks.filter((r, c) => r !== NO_PICK && t >= 30 + 10 * (c + 1) && hits(track, c, r, ANCHOR, STEP)).length * 100;
  return {
    mine,
    duel: duel({ startsAt, gridAt: startsAt + 30, endsAt: startsAt + MATCH_SECS, anchor: ANCHOR, step: STEP, track, revealed, scores: [points(revealed[0]), points(revealed[1])], ...over }),
  };
}

/** A running Trading Duel on SOL: the head start (12 s in), mid game (84 s) or the last column (144 s). */
export function duelLive(kind: "headstart" | "mid" | "last"): Partial<DuelView> {
  const t = { headstart: 12, mid: 84, last: 144 }[kind];
  const g = gridDuel(t);
  return { stage: "live", seat: 0, asset: ASSETS[0], duel: g.duel, book: book(0, g.mine) };
}

export function duel(over: Partial<Duel> = {}): Duel {
  return {
    address: key(50),
    matchId: 0n,
    tesoroMatch: key(51),
    players: [key(70), key(71)],
    asset: ASSETS[0],
    status: STATUS.live,
    finalized: false,
    winner: NO_WINNER,
    startDeadline: secs() + 60,
    startsAt: secs() - 90,
    gridAt: secs() - 60,
    endsAt: secs() + 60,
    anchor: ANCHOR,
    step: STEP,
    lastTick: secs(),
    track: newTrack(),
    revealed: [blank(), blank()],
    scores: [0, 0],
    ...over,
  };
}

/** A finished Duel; `won` is whether seat 0 (you) came out ahead. */
export function duelSettled(won: boolean): Partial<DuelView> {
  const t = MATCH_SECS + 30;
  const track = trackAt(MATCH_SECS);
  const sc = (picks: number[]) => picks.filter((r, c) => hits(track, c, r, ANCHOR, STEP)).length * 100;
  const [mineP, theirsP] = won ? [MINE, THEIRS] : [THEIRS, MINE];
  const startsAt = secs() - t;
  return {
    stage: "settled",
    seat: 0,
    asset: ASSETS[0],
    duel: duel({
      status: STATUS.over,
      finalized: true,
      winner: won ? 0 : 1,
      startsAt,
      gridAt: startsAt + 30,
      endsAt: startsAt + MATCH_SECS,
      track,
      revealed: [mineP, theirsP],
      scores: [sc(mineP), sc(theirsP)],
    }),
  };
}
