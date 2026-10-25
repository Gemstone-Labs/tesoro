/**
 * Decoders for the Vanguard accounts (programs/vanguard/src/state.rs).
 *
 * The Battle is zero-copy and the Army is Borsh; both are read at fixed byte offsets. The offsets table is
 * `chain-layout.json`, written by the Rust golden test from the real layout, so a layout change regenerates
 * it with one command and the golden bytes in `fixtures/golden.json` check these decoders against it.
 */
import { PublicKey } from "@solana/web3.js";
import layout from "./chain-layout.json";
import type { EndState } from "../../server/history/end-state";
import type { Army, Change, EndReason, GameEvent, Outcome, Rank, Square } from "./rules";

const B = layout.battle;
const A = layout.army;
const R = layout.battle.ring;
const O = B.offsets;
const NO_PIECE = 255;

export const NO_SQUARE = B.noSquare;
/**
 * The 31 reserved bytes close the Battle, so they sit at the end of the account (the layout table has no entry for them):
 * the end mask is their first 8 bytes. The Army's 32 reserved bytes (its sealing key) have an entry in the layout table.
 */
const END_MASK_AT = B.size - 31;
/** Battle status, as the program writes it. */
export const STATUS = { created: 0, setup: 1, live: 2, over: 3, cancelled: 4 } as const;
/** `Battle.winner` when the Match was a draw / nobody has won. */
export const DRAW = 2;
export const NO_WINNER = 255;
export const UNSET = 255;

const RANKS: Record<number, Rank> = { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "B", 12: "F" };
/** The private codes of a changed piece in its owner's Army: a Major that dug in (plays as a Landmine) and a General of the Army that became a Spy. The public `shown` bytes never hold them. */
export const CODE_DUG_IN = 13;
export const CODE_SWITCHED = 14;
/** The app's rank for the program's code, the rank a piece PLAYS as (13 is a Landmine, 14 a Spy); null for 0 (hidden or empty). */
export const rankOfCode = (code: number): Rank | null => (code === CODE_DUG_IN ? "B" : code === CODE_SWITCHED ? "1" : (RANKS[code] ?? null));
/** The rank a piece was DEALT as, from its owner's code: a dug-in code is a Major, a switched one a General of the Army. */
export const dealtRankOfCode = (code: number): Rank | null => (code === CODE_DUG_IN ? "7" : code === CODE_SWITCHED ? "10" : (RANKS[code] ?? null));
/** What a piece's owner changed about it, from the private code. */
export const changeOfCode = (code: number): Change | null => (code === CODE_DUG_IN ? "dug" : code === CODE_SWITCHED ? "spy" : null);

export interface RingRecord {
  seq: number;
  /** 0 for a slot never written. */
  kind: number;
  data: number[];
}

/** The public Battle, decoded. Squares are `row * 10 + col` and 255 when off the board. */
export interface Battle {
  matchId: bigint;
  /** Bit `id` set when that piece already moved this turn. */
  moved: bigint;
  startDeadline: number;
  entropyDeadline: number;
  /** The turn's deadline, whole rollup seconds. */
  deadline: number;
  startedAt: number;
  /** The sequence number the next event gets. */
  eventSeq: number;
  turnNo: number;
  moves: number;
  ring: RingRecord[];
  tesoroMatch: PublicKey;
  players: [PublicKey, PublicKey];
  sq: number[];
  /** Revealed rank code of each piece (0 while hidden). */
  shown: number[];
  trail: number[][];
  trailLen: number[];
  bump: number;
  authorityBump: number;
  /** Which seat plays the US Army (255 until `deal`). */
  usSeat: number;
  status: number;
  finalized: number;
  permissioned: number;
  /** A seat, `DRAW` or `NO_WINNER`. */
  winner: number;
  reason: number;
  /** The army to act: 0 US, 1 Italy. */
  turn: number;
  stepsLeft: number;
  twoStepActive: number;
  stormDone: number;
  twoStep: [number, number];
  timeouts: [number, number];
  depotClaimed: [number, number];
  /** `LAYOUT_VERSION` / `RULES_VERSION` the Battle was created with. */
  layoutVersion: number;
  rulesVersion: number;
  /** The Match must be dealt by now, or it is cancelled. */
  setupDeadline: number;
  /** The time cap, set at the deal. */
  capDeadline: number;
  /** Whoever pressed create. */
  payer: PublicKey;
  oracleQueue: PublicKey;
  /** The rules stored when the Battle was created. */
  moveCap: number;
  capSecs: number;
  turnSecs: number;
  graceSecs: number;
  openingGraceSecs: number;
  /** A held-back resolve buys no more than this many seconds of the next turn's clock. */
  resolveSlackSecs: number;
  stormFrom: number;
  stormTo: number;
  /** A declared action waiting for `resolve` (see `PENDING`). Public intent only. */
  pendingKind: number;
  pendingPiece: number;
  pendingTo: number;
  pendingSeat: number;
  /** Counts declared actions. */
  actionSeq: number;
  /** The rollup slot of the declare; `resolve` needs a later one. */
  pendingSlot: bigint;
  pendingTime: number;
  /** The slot the deal ran in: nothing is declared in it. */
  dealSlot: bigint;
  /** Bit `id` set for every piece whose rank changed (a dug-in Major, a switched General of the Army), dead ones included. Zero until the Match ends. */
  endMask: bigint;
}

/** `Battle.pendingKind`. */
export const PENDING = { none: 0, move: 1, timeout: 2, cap: 3, blast: 4, rescue: 5, pass: 6 } as const;

/** One side's private state. */
export interface ArmyAccount {
  bump: number;
  table: PublicKey;
  seat: number;
  player: PublicKey;
  /** 0 US, 1 Italy, 255 before the deal. */
  side: number;
  /** Rank code of each of the army's pieces, by `id % 30`. */
  ranks: number[];
  fuel: number;
  truckTurn: number;
  moves: number;
  /** The Player's 32-byte sealing key (`Army.reserved`), written at the deal and zeroed when the Match is wiped. Never leaves the client. */
  sealKey: Uint8Array;
  /** This seat's secret for the Match is in (until the deal spends it). */
  contributed: boolean;
  /** The deal ran: ranks, key and storm share are in. */
  dealt: boolean;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const slice = (b: Uint8Array, at: number, n: number) => Array.from(b.subarray(at, at + n));
const key = (b: Uint8Array, at: number) => new PublicKey(b.slice(at, at + 32));

export function decodeBattle(data: Uint8Array): Battle {
  if (data.length !== B.size) throw new Error(`Battle account is ${data.length} bytes, expected ${B.size}`);
  const v = view(data);
  const n = B.pieceSlots;
  const ring: RingRecord[] = [];
  for (let i = 0; i < R.slots; i++) {
    const at = O.ring + i * R.stride;
    ring.push({ seq: v.getUint32(at + R.seq, true), kind: data[at + R.kind], data: slice(data, at + R.data, R.dataLen) });
  }
  const pair = (at: number): [number, number] => [data[at], data[at + 1]];
  const trail: number[][] = [];
  for (let i = 0; i < n; i++) trail.push(slice(data, O.trail + i * B.trailWidth, B.trailWidth));
  return {
    matchId: v.getBigUint64(O.matchId, true),
    moved: v.getBigUint64(O.moved, true),
    startDeadline: Number(v.getBigInt64(O.startDeadline, true)),
    entropyDeadline: Number(v.getBigInt64(O.entropyDeadline, true)),
    deadline: Number(v.getBigInt64(O.deadline, true)),
    startedAt: Number(v.getBigInt64(O.startedAt, true)),
    eventSeq: v.getUint32(O.eventSeq, true),
    turnNo: v.getUint16(O.turnNo, true),
    moves: v.getUint16(O.moves, true),
    ring,
    tesoroMatch: key(data, O.tesoroMatch),
    players: [key(data, O.players), key(data, O.players + 32)],
    sq: slice(data, O.sq, n),
    shown: slice(data, O.shown, n),
    trail,
    trailLen: slice(data, O.trailLen, n),
    bump: data[O.bump],
    authorityBump: data[O.authorityBump],
    usSeat: data[O.usSeat],
    status: data[O.status],
    finalized: data[O.finalized],
    permissioned: data[O.permissioned],
    winner: data[O.winner],
    reason: data[O.reason],
    turn: data[O.turn],
    stepsLeft: data[O.stepsLeft],
    twoStepActive: data[O.twoStepActive],
    stormDone: data[O.stormDone],
    twoStep: pair(O.twoStep),
    timeouts: pair(O.timeouts),
    depotClaimed: pair(O.depotClaimed),
    layoutVersion: data[O.layoutVersion],
    rulesVersion: data[O.rulesVersion],
    setupDeadline: Number(v.getBigInt64(O.setupDeadline, true)),
    capDeadline: Number(v.getBigInt64(O.capDeadline, true)),
    payer: key(data, O.payer),
    oracleQueue: key(data, O.oracleQueue),
    moveCap: v.getUint16(O.moveCap, true),
    capSecs: v.getUint16(O.capSecs, true),
    turnSecs: data[O.turnSecs],
    graceSecs: data[O.graceSecs],
    openingGraceSecs: data[O.openingGraceSecs],
    resolveSlackSecs: data[O.resolveSlackSecs],
    stormFrom: data[O.stormFrom],
    stormTo: data[O.stormTo],
    pendingKind: data[O.pendingKind],
    pendingPiece: data[O.pendingPiece],
    pendingTo: data[O.pendingTo],
    pendingSeat: data[O.pendingSeat],
    actionSeq: v.getUint32(O.actionSeq, true),
    pendingSlot: v.getBigUint64(O.pendingSlot, true),
    pendingTime: Number(v.getBigInt64(O.pendingTime, true)),
    dealSlot: v.getBigUint64(O.dealSlot, true),
    endMask: v.getBigUint64(END_MASK_AT, true),
  };
}

export function decodeArmy(data: Uint8Array): ArmyAccount {
  if (data.length !== A.size) throw new Error(`Army account is ${data.length} bytes, expected ${A.size}`);
  const v = view(data);
  const O2 = A.offsets;
  return {
    bump: data[O2.bump],
    table: key(data, O2.table),
    seat: data[O2.seat],
    player: key(data, O2.player),
    side: data[O2.side],
    ranks: slice(data, O2.ranks, 30),
    fuel: data[O2.fuel],
    truckTurn: v.getInt32(O2.truckTurn, true),
    moves: v.getUint16(O2.moves, true),
    sealKey: data.slice(O2.reserved, O2.reserved + 32),
    contributed: data[O2.contributed] !== 0,
    dealt: data[O2.dealt] !== 0,
  };
}

/** The public end board kept in the Match history (see `vanguardEndState` in the keeper) as a Battle the board components can show. */
export function battleFromEndState(s: Extract<EndState, { game: "vanguard" }>, match: PublicKey): Battle {
  const b = decodeBattle(new Uint8Array(B.size));
  return {
    ...b,
    tesoroMatch: match,
    players: [new PublicKey(s.players[0]), new PublicKey(s.players[1])],
    usSeat: s.usSeat,
    winner: s.winner,
    reason: s.reason,
    moves: s.moves,
    turnNo: s.turnNo,
    sq: [...s.sq],
    shown: [...s.shown],
    endMask: BigInt(s.endMask),
    depotClaimed: [s.depotClaimed[0], s.depotClaimed[1]],
    status: STATUS.over,
  };
}

const sqr = (s: number): Square => ({ r: Math.floor(s / 10), c: s % 10 });
const armyOf = (code: number): Army => (code === 0 ? "us" : "it");
const OUTCOMES: Outcome[] = ["win", "lose", "tie", "mine", "defuse", "truck"];
const REASONS: EndReason[] = ["truck", "stuck", "timeouts", "cap"];

/** One ring record as the prototype's `GameEvent`, so the animator plays chain events like local ones. */
export function decodeRecord(r: RingRecord): GameEvent | null {
  const d = r.data;
  const seq = r.seq;
  switch (r.kind) {
    case 1:
      return { seq, kind: "move", id: d[0], from: sqr(d[1]), to: sqr(d[2]) };
    case 2:
      return {
        seq,
        kind: "attack",
        att: d[0],
        def: d[1],
        from: sqr(d[2]),
        to: sqr(d[3]),
        outcome: OUTCOMES[d[4]] ?? "lose",
        flash: [d[5], d[6]].filter((id) => id !== NO_PIECE),
      };
    case 3:
      return { seq, kind: "spotted", id: d[0] };
    case 4:
      return { seq, kind: "raid", army: armyOf(d[0]), at: sqr(d[1]) };
    case 5: {
      const dir = d[2] > 127 ? d[2] - 256 : d[2];
      const shifts = [];
      for (let i = 0; i < d[3]; i++) shifts.push({ id: d[4 + i * 3], from: sqr(d[5 + i * 3]), to: sqr(d[6 + i * 3]) });
      return { seq, kind: "storm", axis: d[0] ? "col" : "row", index: d[1], dir: dir >= 0 ? 1 : -1, shifts };
    }
    case 6:
      return { seq, kind: "turn", turn: armyOf(d[0]), timedOut: d[1] !== 0 };
    case 7:
      return { seq, kind: "end", winner: d[0] === 2 ? "draw" : armyOf(d[0]), reason: REASONS[d[1]] ?? "cap" };
    case 8: {
      const shown: { id: number; rank: Rank }[] = [];
      for (let i = 0; i < Math.min(d[2], 8); i++) {
        const rank = rankOfCode(d[3 + i * 2 + 1]);
        if (rank) shown.push({ id: d[3 + i * 2], rank });
      }
      return { seq, kind: "blast", id: d[0], at: sqr(d[1]), shown };
    }
    case 9:
      return { seq, kind: "rescue", colonel: d[0], truck: d[1], from: sqr(d[2]), to: sqr(d[3]) };
    case 10:
      return { seq, kind: "dug_in", army: armyOf(d[0]), id: d[1] };
    case 11:
      return { seq, kind: "pass", army: armyOf(d[0]) };
    case 12:
      return { seq, kind: "switched", id: d[0] };
    default:
      return null;
  }
}

export type Catchup = { kind: "events"; events: GameEvent[] } | { kind: "snap" };

/**
 * The events to play since `cursor`, the sequence number the client plays next (the Battle's `eventSeq` at
 * the last update it handled). More than the ring holds behind: snap to the board instead.
 */
export function eventsSince(b: Battle, cursor: number): Catchup {
  const behind = (b.eventSeq - cursor) >>> 0;
  if (behind > R.slots) return { kind: "snap" };
  const events: GameEvent[] = [];
  for (let i = 0; i < behind; i++) {
    const seq = (cursor + i) >>> 0;
    const rec = b.ring[seq % R.slots];
    if (rec.kind === 0 || rec.seq !== seq) return { kind: "snap" };
    const e = decodeRecord(rec);
    if (e) events.push(e);
  }
  return { kind: "events", events };
}

/** Changes whenever anything a Player can see in the Battle changes. */
export function battleKey(b: Battle): string {
  return [b.status, b.eventSeq, b.turnNo, b.moves, b.turn, b.stepsLeft, b.twoStepActive, b.deadline, b.winner, b.stormDone, b.twoStep, b.timeouts, b.depotClaimed, b.pendingKind, b.actionSeq, b.endMask, b.sq.join(","), b.shown.join(",")].join("|");
}
