import { PublicKey } from "@solana/web3.js";
import { call, check, raise, PHASE, STATUS as HD_STATUS, type Action } from "@/games/holdem/chain";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import { act, deal, newPractice, type Practice } from "@/games/holdem/practice/engine";
import { ASSETS, FILL, LEAD, NO_WINNER, SIDE, STATUS, type Book, type Duel } from "@/games/trading-duel/chain";
import { close, newLedger, open } from "@/games/trading-duel/math";
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
const pct = (mid: bigint, bp: number) => (mid * BigInt(bp)) / 10_000n;

function book(seat: 0 | 1, ledger: ReturnType<typeof newLedger>): Book {
  return { address: key(60 + seat), duel: key(50), player: key(70 + seat), seat, ...ledger, fillCount: ledger.fills.length };
}

/** A running Trading Duel: SOL, 90 s in, you hold a 5x long. */
export function duelLive(kind: "countdown" | "flat" | "long"): Partial<DuelView> {
  const mid = usdToMid(142.5);
  const t0 = secs();
  const startsAt = kind === "countdown" ? t0 + 5 : t0 - 90;
  const l = kind === "long" ? open(close(open(newLedger(), SIDE.long, 1500n, 3, pct(mid, 9950), 15), pct(mid, 10040), 40).ledger, SIDE.long, 3000n, 5, pct(mid, 9920), 60) : newLedger();
  return {
    stage: "live",
    seat: 0,
    asset: ASSETS[0],
    duel: duel({ startsAt, endsAt: startsAt + 300, trades: [l.trades, 2], lead: kind === "long" ? LEAD.seat1 : LEAD.level }),
    book: book(0, l),
  };
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
    endsAt: secs() + 210,
    trades: [0, 0],
    lead: LEAD.level,
    lastTick: secs(),
    finalPrice: 0n,
    finalEquity: [0n, 0n],
    ...over,
  };
}

/** A finished Duel with both fill histories; `won` is whether seat 0 (you) came out ahead. */
export function duelSettled(won: boolean): Partial<DuelView> {
  const mid = usdToMid(142.5);
  const ahead = close(open(newLedger(), SIDE.long, 4000n, 5, pct(mid, 9900), 45), pct(mid, 10_060), 300, FILL.final).ledger;
  const behind = close(open(newLedger(), SIDE.short, 3000n, 10, pct(mid, 10_000), 30), pct(mid, 10_060), 300, FILL.final).ledger;
  const [mine, theirs] = won ? [ahead, behind] : [behind, ahead];
  return {
    stage: "settled",
    seat: 0,
    asset: ASSETS[0],
    duel: duel({
      status: STATUS.over,
      finalized: true,
      winner: won ? 0 : 1,
      startsAt: secs() - 330,
      endsAt: secs() - 30,
      trades: [mine.trades, theirs.trades],
      finalPrice: pct(mid, 10_060),
      finalEquity: [mine.cash, theirs.cash],
    }),
    finalBooks: [book(0, mine), book(1, theirs)],
  };
}
