/**
 * What a Player sees of a chain Match: the public Battle merged with their own Army, drawn with their own
 * army at the bottom.
 *
 * Rank secrecy lives here. A piece's rank reaches the screen from exactly two places: the Player's own Army
 * account (their own pieces) and the Battle's `shown` ranks (the enemy's, once public). The opponent's Army is
 * unreadable on chain, and a mismatched account passed in is ignored.
 */
import { NO_SQUARE, STATUS, changeOfCode, dealtRankOfCode, rankOfCode, type ArmyAccount, type Battle } from "./decode";
import { CHAIN_CLOCK, DEPOTS, SIZE, enemy, startGame, type Army, type Change, type Depot, type Game, type Piece, type Square } from "./rules";
import type { HitSide, ShownPiece } from "./VanguardBoard";
import { rosterOf, type Ledger, type RosterView } from "./powers-ui";

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

/** True once the Match has ended: the Battle's end reveal (every piece face up, the end mask) is in. */
const decided = (b: Battle) => b.status === STATUS.over;

/** The rank change a piece went through, if it did: the end mask names it once the Match is over, whoever owns it. */
function endChange(b: Battle, id: number): Change | undefined {
  if (!decided(b) || ((b.endMask >> BigInt(id)) & 1n) === 0n) return undefined;
  // a changed piece plays as a Landmine (a Major that dug in) or a Spy (a General of the Army that became one)
  const code = b.shown[id];
  return code === 11 ? "dug" : code === 1 ? "spy" : undefined;
}

/**
 * What the owner changed about their own piece `id`: from their Army's private code, so it survives a reload, and from the
 * end mask once the Match is over. The opponent's changes are never known before the end.
 */
export function changeOf(b: Battle, own: ArmyAccount | null, seat: number, id: number): Change | undefined {
  const mine = ownArmy(b, own, seat);
  if (mine && armyOfPiece(id) === mySide(b, seat)) {
    const c = changeOfCode(mine.ranks[id % 30]);
    if (c) return c;
  }
  return endChange(b, id);
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
    const piece: ShownPiece = { id, army, rank, r: at.r, c: at.c, up: rank !== null };
    const changed = changeOf(b, own, seat, id);
    if (changed) piece.changed = changed;
    // an own piece the enemy has seen face up: the Battle published its rank
    if (army === side && b.shown[id] !== 0 && !decided(b)) piece.exposed = true;
    out.push(piece);
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

/**
 * What the Player was shown of each enemy piece, for the roster strip: the rank the Battle publishes now, dead pieces
 * included (they stay published), so it never depends on the event ring. `tenId` is the enemy piece this client once
 * saw face up as a 10 (remembered while the screen lives): if that piece now shows as a Spy, the 10 became one.
 */
export function shownLedger(b: Battle, seat: number, tenId: number | null = null): Ledger {
  const foe = enemy(mySide(b, seat));
  const ledger: Ledger = {};
  for (let id = 0; id < b.shown.length; id++) {
    if (armyOfPiece(id) !== foe) continue;
    const rank = rankOfCode(b.shown[id]);
    if (!rank) continue;
    ledger[id] = id === tenId && rank !== "10" ? ["10", rank] : [rank];
  }
  return ledger;
}

/** The enemy strip ("10 or Spy?" included), from shown pieces only: the Player's own Army is never read. */
export function chainRoster(b: Battle, seat: number, tenId: number | null = null): RosterView {
  const foe = enemy(mySide(b, seat));
  const alive = new Set<number>();
  for (let id = 0; id < b.sq.length; id++) if (armyOfPiece(id) === foe && b.sq[id] !== NO_SQUARE) alive.add(id);
  return rosterOf(alive, b.status >= STATUS.over, shownLedger(b, seat, tenId));
}

/** The enemy piece currently shown as a 10, if any (the client remembers it, see `shownLedger`). */
export function shownTen(b: Battle, seat: number): number | null {
  const foe = enemy(mySide(b, seat));
  for (let id = 0; id < b.shown.length; id++) if (armyOfPiece(id) === foe && b.shown[id] === 10) return id;
  return null;
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
    // own pieces carry the rank they were dealt as and, apart from it, what changed (the rules' `changed`); enemy ones the rank shown
    const rank = army === side ? ((mine ? dealtRankOfCode(mine.ranks[id % 30]) : null) ?? rankOfCode(b.shown[id])) : rankOfCode(b.shown[id]);
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
  const changed: Record<number, Change> = {};
  if (mine) {
    for (let i = 0; i < 30; i++) {
      const c = changeOfCode(mine.ranks[i]);
      if (c) changed[i + (side === "us" ? 30 : 0)] = c;
    }
  }
  return {
    ...g,
    changed,
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
