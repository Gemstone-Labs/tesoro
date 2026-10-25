/**
 * What the screen needs to know about the rank powers, as pure functions over the rules' `Game`: which power a selected
 * piece offers, what a Blast or a jump looks like and what the enemy roster strip may say.
 * Nothing here reads a hidden rank of the other army: the roster strip works from a ledger of what the viewer was shown.
 */
import { ROSTER, act, isWadi, onBoard, rankOf, type Army, type Game, type GameEvent, type Piece, type PowerKind, type Rank, type Square } from "./rules";

/** One line per rank for the in-game rules sheet. */
export const POWER_LINES: [Rank, string][] = [
  ["10", "Become a Spy: turns into a Spy for good, free with your move. Secret."],
  ["9", "Steps one square, or jumps straight across a wadi."],
  ["8", "Rescue: blows up, and your Supply Truck jumps onto its square."],
  ["7", "Dig in: turns into a Landmine for good. Secret."],
  ["6", "Moves one square in any of 8 directions."],
  ["5", "Steps one square, or jumps one piece in a straight line."],
  ["4", "Slides diagonally any distance, never straight."],
  ["3", "Blast: blows up and shows the 8 squares around it to both sides."],
  ["2", "Runs any distance in a straight line."],
  ["1", "Beats the 10, whichever of the two attacks."],
  ["B", "Never moves. Beats every attacker and stays."],
  ["F", "Capture it to win. Moves one square, 3 times."],
];

/** The squares a Blast shows: the up to 8 around the Engineer, never wrapping past an edge. */
export function blastSquares(at: Square): Square[] {
  const out: Square[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && onBoard(at.r + dr, at.c + dc)) out.push({ r: at.r + dr, c: at.c + dc });
  return out;
}

/** A Lieutenant's jump (2 squares) or a General's wadi crossing (3 squares): the marks that get an arc. */
export function isJump(rank: Rank, from: Square, to: Square): boolean {
  return (rank === "5" || rank === "9") && Math.max(Math.abs(from.r - to.r), Math.abs(from.c - to.c)) >= 2;
}

/**
 * Whether a one-line move is a hop, judged from the board alone (the mover's rank may be hidden): two squares over an occupied
 * square is a Lieutenant's jump, three squares across two wadi squares is a General's crossing. A Recon's run never has an
 * occupied or wadi square under it, so it slides.
 */
export function isHopMove(from: Square, to: Square, occupied: (r: number, c: number) => boolean): boolean {
  const dr = to.r - from.r;
  const dc = to.c - from.c;
  if ((dr !== 0 && dc !== 0) || (dr === 0 && dc === 0)) return false;
  const n = Math.abs(dr || dc);
  const sr = Math.sign(dr);
  const sc = Math.sign(dc);
  if (n === 2) return occupied(from.r + sr, from.c + sc);
  if (n === 3) return isWadi(from.r + sr, from.c + sc) && isWadi(from.r + 2 * sr, from.c + 2 * sc);
  return false;
}

export interface PowerOption {
  kind: PowerKind;
  /** The name on the button. */
  label: string;
  /** One line under it. */
  hint: string;
  /** Blast and Rescue draw what they will do while the piece is selected (no extra tap); Dig in has nothing to draw. */
  preview: boolean;
}

const OPTIONS: Record<PowerKind, PowerOption> = {
  blast: { kind: "blast", label: "Blast", hint: "The Engineer blows up. Both sides see the 8 squares around it.", preview: true },
  rescue: { kind: "rescue", label: "Rescue", hint: "The Colonel blows up and your Truck jumps onto its square.", preview: true },
  dig_in: { kind: "dig_in", label: "Dig in", hint: "The Major becomes a Landmine for good. Uses your turn.", preview: false },
};

const POWER_OF: Partial<Record<Rank, PowerKind>> = { "3": "blast", "8": "rescue", "7": "dig_in" };

/** The power the selected piece offers right now, asked of the rules themselves so the button and the rules never disagree. */
export function powerFor(g: Game, p: Piece): PowerOption | null {
  if (g.winner || p.army !== g.turn) return null;
  const kind = POWER_OF[rankOf(g, p)];
  if (!kind) return null;
  return act(g, { kind, id: p.id, at: g.startedAt }).ok ? OPTIONS[kind] : null;
}

/** Why a power is not on offer for a piece that has one (inside a Two-Step Turn, or after a step). */
export function powerBlockedLine(g: Game, p: Piece): string {
  if (g.winner || p.army !== g.turn || !POWER_OF[rankOf(g, p)]) return "";
  return g.twoStepActive || g.movedThisTurn.length ? "A power takes the whole turn: not after a step." : "";
}

/** The side's General of the Army may become a Spy: it is the live, unswitched 10. */
export function canSwitch(g: Game, p: Piece): boolean {
  return g.version >= 6 && !g.winner && p.army === g.turn && p.rank === "10" && !g.changed[p.id];
}

/** What the viewer was shown of each enemy piece, oldest first (the last entry is how it plays now). Dead pieces stay in it. */
export type Ledger = Record<number, Rank[]>;

/**
 * Fold what one action showed into the ledger. Only pieces of `foe` are recorded. A casualty is recorded as the rank it
 * fought as (`after.changed`), so a switched 10 that dies shows as a Spy.
 */
export function observe(ledger: Ledger, events: GameEvent[], before: Game, after: Game, foe: Army = "it"): Ledger {
  const next: Ledger = { ...ledger };
  const armyOf = (id: number) => before.pieces.find((p) => p.id === id)?.army;
  const see = (id: number, rank: Rank) => {
    if (armyOf(id) !== foe) return;
    const h = next[id] ?? [];
    if (h[h.length - 1] !== rank) next[id] = [...h, rank];
  };
  for (const e of events) {
    if (e.kind === "attack") {
      for (const id of e.flash) {
        const p = before.pieces.find((x) => x.id === id);
        if (p) see(id, rankOf(after, p));
      }
    } else if (e.kind === "blast") {
      see(e.id, "3");
      for (const s of e.shown) see(s.id, s.rank);
    } else if (e.kind === "rescue") {
      see(e.colonel, "8");
      see(e.truck, "F");
    } else if (e.kind === "spotted") see(e.id, "F");
    else if (e.kind === "switched") see(e.id, "1");
    else if (e.kind === "dug_in") see(e.id, "B");
  }
  return next;
}

export interface RosterCell {
  rank: Rank;
  of: number;
  left: number;
}

export interface RosterView {
  cells: RosterCell[];
  /** The 10 has not been seen and may be a Spy now: the strip says "10 or Spy?". */
  tenOrSpy: boolean;
}

/**
 * The enemy strip, from what the viewer was shown only: distinct shown pieces (dead ones included) and the 10's
 * identity when it is unproven. A Dig in is secret and never counted here. It never reads a rank that was not shown.
 */
export function rosterView(game: Game, ledger: Ledger, foe: Army = "it"): RosterView {
  return rosterOf(new Set(game.pieces.filter((p) => p.army === foe).map((p) => p.id)), !!game.winner, ledger);
}

/** The strip from the foe's piece numbers still on the board, whether the Match is over, and what was shown. */
export function rosterOf(alive: ReadonlySet<number>, over: boolean, ledger: Ledger): RosterView {
  const last = (id: number) => ledger[id][ledger[id].length - 1];
  const ids = Object.keys(ledger).map(Number);
  const deadAs = (r: Rank) => ids.filter((id) => !alive.has(id) && last(id) === r).length;
  const tens = ids.filter((id) => ledger[id].includes("10"));
  const spies = ids.filter((id) => last(id) === "1");
  const switched = tens.some((id) => last(id) === "1") || spies.length >= 2;
  const tenSeen = tens.length > 0;
  const tenLeft = switched ? 0 : tenSeen ? (alive.has(tens[0]) ? 1 : 0) : 1;
  const cells = ROSTER.map(([rank, n]): RosterCell => {
    if (rank === "10") return { rank, of: n, left: tenLeft };
    const of = rank === "1" && switched ? n + 1 : n;
    return { rank, of, left: Math.max(0, of - deadAs(rank)) };
  });
  return { cells, tenOrSpy: !over && !tenSeen && !switched && tenLeft === 1 };
}
