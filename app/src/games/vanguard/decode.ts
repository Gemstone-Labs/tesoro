/**
 * Decoders for the Vanguard accounts (programs/vanguard/src/state.rs).
 *
 * The Battle is zero-copy and the Army is Borsh; both are read at fixed byte offsets. The offsets table is
 * `chain-layout.json`, written by the Rust golden test from the real layout, so a layout change regenerates
 * it with one command and the golden bytes in `fixtures/golden.json` check these decoders against it.
 */
import { PublicKey } from "@solana/web3.js";
import layout from "./chain-layout.json";
import type { Army, EndReason, GameEvent, Outcome, Rank, Square } from "./rules";

const B = layout.battle;
const A = layout.army;
const R = layout.battle.ring;
const O = B.offsets;
const NO_PIECE = 255;

export const NO_SQUARE = B.noSquare;
/** Battle status, as the program writes it. */
export const STATUS = { created: 0, setup: 1, live: 2, over: 3, cancelled: 4 } as const;
/** `Battle.winner` when the Match was a draw / nobody has won. */
export const DRAW = 2;
export const NO_WINNER = 255;
export const UNSET = 255;

const RANKS: Record<number, Rank> = { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "B", 12: "F" };
/** The app's rank for the program's code; null for 0 (hidden or empty). */
export const rankOfCode = (code: number): Rank | null => RANKS[code] ?? null;

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
}

/** One side's private state. */
export interface ArmyAccount {
  bump: number;
  battle: PublicKey;
  seat: number;
  player: PublicKey;
  /** 0 US, 1 Italy, 255 before the deal. */
  side: number;
  /** Rank code of each of the army's pieces, by `id % 30`. */
  ranks: number[];
  fuel: number;
  truckTurn: number;
  moves: number;
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
  };
}

export function decodeArmy(data: Uint8Array): ArmyAccount {
  if (data.length !== A.size) throw new Error(`Army account is ${data.length} bytes, expected ${A.size}`);
  const v = view(data);
  const O2 = A.offsets;
  return {
    bump: data[O2.bump],
    battle: key(data, O2.battle),
    seat: data[O2.seat],
    player: key(data, O2.player),
    side: data[O2.side],
    ranks: slice(data, O2.ranks, 30),
    fuel: data[O2.fuel],
    truckTurn: v.getInt32(O2.truckTurn, true),
    moves: v.getUint16(O2.moves, true),
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
