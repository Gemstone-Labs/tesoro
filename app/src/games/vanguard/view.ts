/**
 * What a Player sees of a chain Match: the public Battle merged with their own Army, drawn with their own
 * army at the bottom.
 *
 * Rank secrecy lives here. A piece's rank reaches the screen from exactly two places: the Player's own Army
 * account (their own pieces) and the Battle's `shown` ranks (the enemy's, once public). The opponent's Army is
 * unreadable on chain, and a mismatched account passed in is ignored.
 */
import { NO_SQUARE, rankOfCode, type ArmyAccount, type Battle } from "./decode";
import { CHAIN_CLOCK, DEPOTS, ROSTER, SIZE, enemy, startGame, type Army, type Depot, type Game, type Piece, type Rank, type Square } from "./rules";
import type { HitSide, ShownPiece } from "./VanguardBoard";

/** Pieces 0-29 are the Italian Army's, 30-59 the US Army's (the start-square numbering). */
export const armyOfPiece = (id: number): Army => (id >= 30 ? "us" : "it");

/** The army a seat plays. */
export const mySide = (b: Battle, seat: number): Army => (b.usSeat === seat ? "us" : "it");

/** The Player turned the board half way round when they play Italy, so their own army is at the bottom. */
export const toView = (s: Square, side: Army): Square => (side === "us" ? s : { r: SIZE - 1 - s.r, c: SIZE - 1 - s.c });
/** The same turn undone: a square on the screen back to the board's own coordinates. */
export const fromView = toView;

export const squareOf = (index: number): Square => ({ r: Math.floor(index / 10), c: index % 10 });
export const indexOf = (s: Square): number => s.r * 10 + s.c;

/** The own Army account, only if it is the account of this seat's army. */
function ownArmy(b: Battle, own: ArmyAccount | null, seat: number): ArmyAccount | null {
  if (!own || own.seat !== seat) return null;
  return own.side === (mySide(b, seat) === "us" ? 0 : 1) ? own : null;
}

/** Every piece still on the board, as the Player at `seat` sees it (view coordinates). */
export function shownPieces(b: Battle, own: ArmyAccount | null, seat: number): ShownPiece[] {
  const side = mySide(b, seat);
  const mine = ownArmy(b, own, seat);
  const out: ShownPiece[] = [];
  for (let id = 0; id < b.sq.length; id++) {
    if (b.sq[id] === NO_SQUARE) continue;
    const army = armyOfPiece(id);
    const rank = army === side ? ((mine ? rankOfCode(mine.ranks[id % 30]) : null) ?? rankOfCode(b.shown[id])) : rankOfCode(b.shown[id]);
    const at = toView(squareOf(b.sq[id]), side);
    out.push({ id, army, rank, r: at.r, c: at.c, up: rank !== null });
  }
  return out;
}

/** The two Supply Depots in view coordinates, `claimed` from the Battle. */
export function depotsFor(b: Battle, side: Army): Depot[] {
  return DEPOTS.map((d) => {
    const at = toView(d, side);
    return { ...at, raider: d.raider, claimed: b.depotClaimed[d.raider === "us" ? 0 : 1] !== 0 };
  });
}

/** The side of a piece that was hit when something moved from `from` to `to`, as the Player sees it. */
export function hitSide(from: Square, to: Square, side: Army): HitSide {
  const a = toView(from, side);
  const z = toView(to, side);
  const dr = Math.sign(z.r - a.r);
  const dc = Math.sign(z.c - a.c);
  return dc > 0 ? "left" : dc < 0 ? "right" : dr > 0 ? "top" : "bottom";
}

export const opposite = (h: HitSide): HitSide => ({ left: "right", right: "left", top: "bottom", bottom: "top" })[h] as HitSide;

/** How many of each enemy rank are still standing, from the piece list: on the board, or not yet seen leaving. */
export function enemyLeft(b: Battle, seat: number): Record<Rank, number> {
  const foe = enemy(mySide(b, seat));
  const left = Object.fromEntries(ROSTER.map(([rank, n]) => [rank, n])) as Record<Rank, number>;
  for (let id = 0; id < b.sq.length; id++) {
    if (armyOfPiece(id) !== foe || b.sq[id] !== NO_SQUARE) continue;
    const rank = rankOfCode(b.shown[id]);
    if (rank) left[rank] = Math.max(0, left[rank] - 1);
  }
  return left;
}

export const piecesLeft = (b: Battle, army: Army): number => {
  let n = 0;
  for (let id = 0; id < b.sq.length; id++) if (armyOfPiece(id) === army && b.sq[id] !== NO_SQUARE) n++;
  return n;
};

/**
 * The rules engine's `Game` for working out which squares a piece may reach. Enemy ranks are unknown to the
 * client and are never read for that (a target only needs to know a square is held by the enemy), so they
 * are filled with a rank-less stand-in that no screen draws.
 */
export function lookGame(b: Battle, own: ArmyAccount | null, seat: number): Game {
  const side = mySide(b, seat);
  const mine = ownArmy(b, own, seat);
  const turn: Army = b.turn === 0 ? "us" : "it";
  const g = startGame([], { startedAt: b.startedAt * 1000, stormAt: 0, stormSeed: 0, first: turn, clock: CHAIN_CLOCK, version: b.rulesVersion });
  const pieces: Piece[] = [];
  for (let id = 0; id < b.sq.length; id++) {
    if (b.sq[id] === NO_SQUARE) continue;
    const army = armyOfPiece(id);
    const at = squareOf(b.sq[id]);
    const rank = army === side ? ((mine ? rankOfCode(mine.ranks[id % 30]) : null) ?? rankOfCode(b.shown[id])) : rankOfCode(b.shown[id]);
    pieces.push({
      id,
      army,
      rank: rank ?? "1",
      r: at.r,
      c: at.c,
      known: b.shown[id] !== 0,
      fuel: rank === "F" && mine ? mine.fuel : 0,
      trail: b.trail[id].slice(0, b.trailLen[id]).map((s) => `${Math.floor(s / 10)},${s % 10}`),
    });
  }
  return {
    ...g,
    pieces,
    depots: DEPOTS.map((d) => ({ ...d, claimed: b.depotClaimed[d.raider === "us" ? 0 : 1] !== 0 })),
    turn,
    turnNo: b.turnNo,
    moves: b.moves,
    twoStep: { us: b.twoStep[0], it: b.twoStep[1] },
    stepsLeft: b.stepsLeft,
    twoStepActive: b.twoStepActive !== 0,
    timeouts: { us: b.timeouts[0], it: b.timeouts[1] },
    truckTurn: { us: side === "us" && mine ? mine.truckTurn : -9, it: side === "it" && mine ? mine.truckTurn : -9 },
    movedThisTurn: Array.from({ length: 60 }, (_, i) => i).filter((i) => ((b.moved >> BigInt(i)) & 1n) !== 0n),
    deadline: b.deadline * 1000,
    stormDone: b.stormDone !== 0,
  };
}
