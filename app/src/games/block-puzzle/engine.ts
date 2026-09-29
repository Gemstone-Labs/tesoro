/**
 * Block Puzzle engine: exact port of programs/block_puzzle/src/engine.rs.
 * Rules, PRNG and scoring are documented there. Any change must land in both
 * files and regenerate programs/block_puzzle/tests/vectors.json.
 */

export const SIZE = 8;
export const HAND = 3;
export const KINDS = 14;
export const MAX_MOVES = 120;
export const GEM_ONE_IN = 5n;
export const LINE_POINTS = 10;

const MASK64 = (1n << 64n) - 1n;
const ROW0 = 0xffn;
const COL0 = 0x0101010101010101n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const XORSHIFT_MUL = 0x2545f4914f6cdd1dn;

/** [width, height, 4x4 mask with bit y*4+x] per piece kind. */
export const SHAPES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0b1],
  [2, 1, 0b11],
  [1, 2, 0b10001],
  [3, 1, 0b111],
  [1, 3, 0x111],
  [4, 1, 0b1111],
  [1, 4, 0x1111],
  [2, 2, 0b110011],
  [2, 2, 0b10011],
  [2, 2, 0b100011],
  [2, 2, 0b110001],
  [2, 2, 0b110010],
  [3, 2, 0b100111],
  [3, 2, 0b110110],
];

export interface Piece {
  kind: number;
  /** Row-major index among the piece's cells of its gem, or null. */
  gem: number | null;
}
export interface Move {
  piece: number;
  x: number;
  y: number;
}
export type EngineError = "GameOver" | "BadPiece" | "PieceUsed" | "OutOfBounds" | "Occupied" | "Overflow";
export interface MoveResult {
  gained: number;
  lines: number;
  gems: number;
  /** Bitboard of the cells cleared by this move (UI animation only). */
  cleared: bigint;
}
export interface State {
  seed: bigint;
  occ: bigint;
  gems: bigint;
  score: number;
  moves: number;
  used: number;
  over: boolean;
}

export class EngineFailure extends Error {
  constructor(readonly code: EngineError) {
    super(code);
  }
}

const u64 = (v: bigint) => v & MASK64;

function next(x: bigint): bigint {
  x ^= x >> 12n;
  x ^= u64(x << 25n);
  x ^= x >> 27n;
  return x;
}

function popcount(v: bigint): number {
  let n = 0;
  while (v) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}

export function pieceAt(seed: bigint, index: number): Piece {
  let s = u64(seed) ^ u64((BigInt(index) + 1n) * GOLDEN);
  if (s === 0n) s = GOLDEN;
  s = next(next(next(next(s))));
  s = next(s);
  const d1 = u64(s * XORSHIFT_MUL);
  s = next(s);
  const d2 = u64(s * XORSHIFT_MUL);
  const kind = Number((d1 >> 32n) % BigInt(KINDS));
  const cells = BigInt(popcount(BigInt(SHAPES[kind][2])));
  const gem = (d2 >> 32n) % GEM_ONE_IN === 0n ? Number((d2 >> 8n) % cells) : null;
  return { kind, gem };
}

/** Footprint at anchor (0,0) on the 8x8 bitboard plus its gem bit (0n if none). */
export function footprint(piece: Piece): { bits: bigint; gem: bigint } {
  const mask = SHAPES[piece.kind][2];
  let bits = 0n;
  let gem = 0n;
  let n = 0;
  for (let i = 0; i < 16; i++) {
    if ((mask >> i) & 1) {
      const bit = 1n << BigInt(Math.floor(i / 4) * 8 + (i % 4));
      bits |= bit;
      if (piece.gem === n) gem = bit;
      n++;
    }
  }
  return { bits, gem };
}

export function dims(piece: Piece): [number, number] {
  const s = SHAPES[piece.kind];
  return [s[0], s[1]];
}

/** Cells (dx, dy, isGem) of a piece, row-major. */
export function pieceCells(piece: Piece): { dx: number; dy: number; gem: boolean }[] {
  const mask = SHAPES[piece.kind][2];
  const out: { dx: number; dy: number; gem: boolean }[] = [];
  let n = 0;
  for (let i = 0; i < 16; i++) {
    if ((mask >> i) & 1) {
      out.push({ dx: i % 4, dy: Math.floor(i / 4), gem: piece.gem === n });
      n++;
    }
  }
  return out;
}

export function newState(seed: bigint): State {
  return { seed: u64(seed), occ: 0n, gems: 0n, score: 0, moves: 0, used: 0, over: false };
}

export function handBase(st: State): number {
  return Math.floor(st.moves / HAND) * HAND;
}

export function fitsAt(st: State, piece: Piece, x: number, y: number): boolean {
  const [w, h] = dims(piece);
  if (x < 0 || y < 0 || x + w > SIZE || y + h > SIZE) return false;
  return (st.occ & (footprint(piece).bits << BigInt(y * SIZE + x))) === 0n;
}

export function fitsAnywhere(st: State, piece: Piece): boolean {
  const [w, h] = dims(piece);
  for (let y = 0; y <= SIZE - h; y++) {
    for (let x = 0; x <= SIZE - w; x++) {
      if (fitsAt(st, piece, x, y)) return true;
    }
  }
  return false;
}

function anyFits(st: State): boolean {
  const base = handBase(st);
  for (let n = 0; n < HAND; n++) {
    if (((st.used >> n) & 1) === 0 && fitsAnywhere(st, pieceAt(st.seed, base + n))) return true;
  }
  return false;
}

/** Returns the new state and move result, or throws EngineFailure. Does not mutate `st`. */
export function apply(st: State, mv: Move): { state: State; result: MoveResult } {
  if (st.over) throw new EngineFailure("GameOver");
  const base = handBase(st);
  if (!Number.isInteger(mv.piece) || mv.piece < base || mv.piece >= base + HAND) throw new EngineFailure("BadPiece");
  const slot = mv.piece - base;
  if ((st.used >> slot) & 1) throw new EngineFailure("PieceUsed");
  const piece = pieceAt(st.seed, mv.piece);
  const [w, h] = dims(piece);
  if (!Number.isInteger(mv.x) || !Number.isInteger(mv.y) || mv.x < 0 || mv.y < 0 || mv.x + w > SIZE || mv.y + h > SIZE) {
    throw new EngineFailure("OutOfBounds");
  }
  const shift = BigInt(mv.y * SIZE + mv.x);
  const fp = footprint(piece);
  const bits = fp.bits << shift;
  if (st.occ & bits) throw new EngineFailure("Occupied");

  let occ = st.occ | bits;
  let gems = st.gems | (fp.gem << shift);
  let clear = 0n;
  let lines = 0;
  for (let i = 0; i < SIZE; i++) {
    const row = ROW0 << BigInt(i * SIZE);
    if ((occ & row) === row) {
      clear |= row;
      lines++;
    }
    const col = COL0 << BigInt(i);
    if ((occ & col) === col) {
      clear |= col;
      lines++;
    }
  }
  const gemHits = popcount(gems & clear);
  let gained = popcount(bits);
  if (lines > 0) gained += LINE_POINTS * lines * lines * (1 + gemHits);
  const score = st.score + gained;
  if (!Number.isSafeInteger(score) || score > 0xffffffff) throw new EngineFailure("Overflow");

  occ &= ~clear;
  gems &= ~clear;
  let used = st.used | (1 << slot);
  if (used === 7) used = 0;
  const state: State = { seed: st.seed, occ, gems, score, moves: st.moves + 1, used, over: false };
  state.over = state.moves >= MAX_MOVES || !anyFits(state);
  return { state, result: { gained, lines, gems: gemHits, cleared: clear } };
}

export type ReplayResult = { ok: true; state: State } | { ok: false; error: EngineError; at: number };

export function replay(seed: bigint, moves: readonly Move[]): ReplayResult {
  let st = newState(seed);
  for (let i = 0; i < moves.length; i++) {
    try {
      st = apply(st, moves[i]).state;
    } catch (e) {
      if (e instanceof EngineFailure) return { ok: false, error: e.code, at: i };
      throw e;
    }
  }
  return { ok: true, state: st };
}
