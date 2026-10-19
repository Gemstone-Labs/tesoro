/**
 * Catching a Vanguard client up with the Battle: which recorded events to play, what a declared-but-unresolved
 * action looks like on screen, and the line for a lost turn. Pure functions over the decoded Battle; the ring only
 * drives animations, the board is always drawn from the piece list.
 */
import { NO_SQUARE, PENDING, eventsSince, type Battle } from "./decode";
import type { Army, GameEvent } from "./rules";

export type CatchUp = { mode: "idle" } | { mode: "play"; events: GameEvent[] } | { mode: "snap" };

/**
 * What to do when the Battle's event counter is ahead of `cursor` (the sequence number the client plays next):
 * every newer record in order, or a snap to the board when the ring has been lapped (more than 16 behind).
 */
export function catchUp(b: Battle, cursor: number): CatchUp {
  if (b.eventSeq === cursor) return { mode: "idle" };
  const c = eventsSince(b, cursor);
  return c.kind === "snap" ? { mode: "snap" } : { mode: "play", events: c.events };
}

/** A declared action waiting for `resolve`, as the screen may describe it. Public intent only, never an outcome. */
export interface PendingView {
  kind: "move" | "attack" | "pass" | "cap";
  mine: boolean;
  piece: number | null;
  line: string;
}

/**
 * The pending action of a live Battle. A move is an "attack" when the square it aims at holds a piece, which is
 * public; whether it succeeds, who wins or even whether the program accepts it is not known until `resolve`.
 */
export function pendingOf(b: Battle, seat: number): PendingView | null {
  if (b.pendingKind === PENDING.none) return null;
  if (b.pendingKind === PENDING.timeout) return { kind: "pass", mine: false, piece: null, line: "A turn ran out of time. Passing it…" };
  if (b.pendingKind === PENDING.cap) return { kind: "cap", mine: false, piece: null, line: "Time limit reached. Counting the armies…" };
  const mine = b.pendingSeat === seat;
  const attack = b.sq.some((s, id) => s === b.pendingTo && s !== NO_SQUARE && id !== b.pendingPiece);
  const kind = attack ? "attack" : "move";
  const line = mine
    ? `Your ${kind} is being applied…`
    : kind === "attack"
      ? "Your opponent is attacking…"
      : "Your opponent is making a move…";
  return { kind, mine, piece: b.pendingPiece, line };
}

/**
 * The line for a `turn` record. The record holds the army that plays next, so a timed-out record with `turn` set
 * to your own army means the opponent's turn ran out. A turn you lost right after declaring a move was not a late
 * turn: the program refused the move and it cost the turn.
 */
export function turnLine(e: Extract<GameEvent, { kind: "turn" }>, side: Army, declaredByYou: boolean): string | null {
  if (!e.timedOut) return null;
  const yours = e.turn !== side;
  if (yours) return declaredByYou ? "Move refused: turn lost." : "Time! Turn passed.";
  return "Opponent ran out of time.";
}
