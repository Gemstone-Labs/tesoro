/**
 * Battle and Army accounts built from the rules engine, for stories and tests. A `Game` plays out as the program
 * would play it; this turns it, and the events so far, into the decoded accounts a client reads. Nothing here
 * runs in the app.
 */
import { PublicKey } from "@solana/web3.js";
import { NO_SQUARE, type ArmyAccount, type Battle, type RingRecord } from "./decode";
import { CHAIN_CLOCK, DEPOTS, RULES_VERSION, TURN_MS, newGame, seeded, startIndex, type Game, type GameEvent, type Rank } from "./rules";

const CODE: Record<Rank, number> = { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, B: 11, F: 12 };
const OUTCOME = ["win", "lose", "tie", "mine", "defuse", "truck"] as const;
const REASON = ["truck", "stuck", "timeouts", "cap"] as const;
const sq = (s: { r: number; c: number }) => s.r * 10 + s.c;
const armyCode = (a: "us" | "it") => (a === "us" ? 0 : 1);

/** An event as a ring record, the inverse of `decodeRecord`. */
export function encodeEvent(e: GameEvent): RingRecord {
  const d = Array<number>(35).fill(0);
  let kind = 0;
  switch (e.kind) {
    case "move":
      kind = 1;
      d.splice(0, 3, e.id, sq(e.from), sq(e.to));
      break;
    case "attack":
      kind = 2;
      d.splice(0, 7, e.att, e.def, sq(e.from), sq(e.to), OUTCOME.indexOf(e.outcome), e.flash[0] ?? 255, e.flash[1] ?? 255);
      break;
    case "spotted":
      kind = 3;
      d[0] = e.id;
      break;
    case "raid":
      kind = 4;
      d.splice(0, 2, armyCode(e.army), sq(e.at));
      break;
    case "storm":
      kind = 5;
      d.splice(0, 4, e.axis === "col" ? 1 : 0, e.index, e.dir < 0 ? 255 : 1, e.shifts.length);
      e.shifts.forEach((s, i) => d.splice(4 + i * 3, 3, s.id, sq(s.from), sq(s.to)));
      break;
    case "turn":
      kind = 6;
      d.splice(0, 2, armyCode(e.turn), e.timedOut ? 1 : 0);
      break;
    case "end":
      kind = 7;
      d.splice(0, 2, e.winner === "draw" ? 2 : armyCode(e.winner), REASON.indexOf(e.reason));
      break;
  }
  return { seq: e.seq, kind, data: d };
}

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
export const FIXTURE_PLAYERS: [PublicKey, PublicKey] = [key(11), key(12)];

export interface ChainState {
  battle: Battle;
  /** Both Armies; a client only ever reads the one at its own seat. */
  armies: [ArmyAccount, ArmyAccount];
}

/**
 * The accounts for `game` after `history` happened. `start` is the game before any action (it knows every
 * rank, so a piece that left the board can be shown with the rank it had).
 */
export function chainState(game: Game, start: Game, history: GameEvent[], o: { usSeat?: 0 | 1; seenAt?: number } = {}): ChainState {
  const usSeat = o.usSeat ?? 0;
  const over = game.winner !== null;
  const revealed = new Set<number>();
  for (const e of history) {
    if (e.kind === "attack") e.flash.forEach((id) => revealed.add(id));
    if (e.kind === "spotted") revealed.add(e.id);
  }
  const rankOf = new Map(start.pieces.map((p) => [p.id, p.rank]));
  const sqs = Array<number>(60).fill(NO_SQUARE);
  const shown = Array<number>(60).fill(0);
  const trail = Array.from({ length: 60 }, () => Array<number>(6).fill(0));
  const trailLen = Array<number>(60).fill(0);
  for (const p of game.pieces) {
    sqs[p.id] = sq(p);
    if (p.known || over) shown[p.id] = CODE[p.rank];
    const t = p.trail.slice(-6).map((s) => Number(s.split(",")[0]) * 10 + Number(s.split(",")[1]));
    t.forEach((v, i) => (trail[p.id][i] = v));
    trailLen[p.id] = t.length;
  }
  for (const id of revealed) shown[id] ||= CODE[rankOf.get(id) ?? "1"];
  const ring: RingRecord[] = Array.from({ length: 16 }, () => ({ seq: 0, kind: 0, data: Array<number>(35).fill(0) }));
  for (const e of history.slice(-16)) ring[e.seq % 16] = encodeEvent(e);
  const startedAt = Math.floor(game.startedAt / 1000);
  const winnerSeat = game.winner === null ? 255 : game.winner === "draw" ? 2 : game.winner === "us" ? usSeat : 1 - usSeat;
  let moved = 0n;
  for (const id of game.movedThisTurn) moved |= 1n << BigInt(id);
  const battle: Battle = {
    matchId: 1_800_000_000_001n,
    moved,
    startDeadline: startedAt + 300,
    entropyDeadline: 0,
    deadline: Math.floor(game.deadline / 1000),
    startedAt,
    eventSeq: game.eventSeq,
    turnNo: game.turnNo,
    moves: game.moves,
    ring,
    tesoroMatch: key(10),
    players: FIXTURE_PLAYERS,
    sq: sqs,
    shown,
    trail,
    trailLen,
    bump: 255,
    authorityBump: 255,
    usSeat,
    status: over ? 3 : 2,
    finalized: 0,
    permissioned: 1,
    winner: winnerSeat,
    reason: game.reason ? REASON.indexOf(game.reason) : 255,
    turn: game.turn === "us" ? 0 : 1,
    stepsLeft: game.stepsLeft,
    twoStepActive: game.twoStepActive ? 1 : 0,
    stormDone: game.stormDone ? 1 : 0,
    twoStep: [game.twoStep.us, game.twoStep.it],
    timeouts: [game.timeouts.us, game.timeouts.it],
    depotClaimed: [game.depots.find((d) => d.raider === "us")?.claimed ? 1 : 0, game.depots.find((d) => d.raider === "it")?.claimed ? 1 : 0],
    layoutVersion: 2,
    rulesVersion: RULES_VERSION,
    setupDeadline: 0,
    capDeadline: 0,
    payer: key(11),
    oracleQueue: key(12),
    moveCap: 200,
    capSecs: 900,
    turnSecs: TURN_MS / 1000,
    graceSecs: 1,
    openingGraceSecs: 10,
    resolveSlackSecs: 2,
    stormFrom: 10,
    stormTo: 18,
    pendingKind: 0,
    pendingPiece: 0,
    pendingTo: 0,
    pendingSeat: 0,
    actionSeq: 0,
    pendingSlot: 0n,
    pendingTime: 0,
    dealSlot: 0n,
  };
  const army = (a: "us" | "it", seat: 0 | 1): ArmyAccount => {
    const ranks = Array<number>(30).fill(0);
    let truck = -9;
    for (const p of start.pieces) if (p.army === a) ranks[p.id % 30] = CODE[p.rank];
    truck = game.truckTurn[a];
    const fuel = game.pieces.find((p) => p.army === a && p.rank === "F")?.fuel ?? 0;
    return { bump: 255, battle: key(20), seat, player: FIXTURE_PLAYERS[seat], side: armyCode(a), ranks, fuel, truckTurn: truck, moves: 0 };
  };
  const seatOfUs = usSeat;
  const armies: [ArmyAccount, ArmyAccount] = [army(seatOfUs === 0 ? "us" : "it", 0), army(seatOfUs === 0 ? "it" : "us", 1)];
  return { battle, armies };
}

/** A fresh Match on the chain clock: the US Army to move, 10 seconds a turn. */
export function freshGame(seed = 7, at = Date.now()): Game {
  return newGame(seeded(seed), at, "us", CHAIN_CLOCK);
}

export const depotSquares = DEPOTS.map((d) => ({ r: d.r, c: d.c }));
export { startIndex };
