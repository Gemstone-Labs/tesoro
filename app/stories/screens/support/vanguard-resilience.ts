import { chainState, freshGame, type ChainState } from "@/games/vanguard/fixture";
import { botMove } from "@/games/vanguard/practice/bot";
import { move, seeded, targets, timeout, type Game, type GameEvent, type Result } from "@/games/vanguard/rules";
import type { Battle } from "@/games/vanguard/decode";
import type { VanguardView } from "@/games/vanguard/useVanguardMatch";
import { chainMatch } from "./matches";

const T0 = () => Date.now() - 20_000;
const ok = (r: Result) => {
  if (!r.ok) throw new Error(`fixture action refused: ${r.reason}`);
  return r;
};

const live = (s: ChainState, o: Partial<VanguardView> = {}): Partial<VanguardView> => ({
  stage: "live",
  match: chainMatch("vanguard", "active"),
  seat: 0,
  battle: s.battle,
  army: s.armies[0],
  turnSeenAt: Date.now(),
  ...o,
});

/** `n` plain moves from the opening, alternating armies: the game, its start, and every event so far. */
function played(n: number) {
  const g0 = freshGame(7, T0());
  let g: Game = g0;
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    const m = botMove(g, seeded(i + 1), "plain");
    if (!m) break;
    const r = ok(move(g, { id: m.id, to: m.to, at: g0.startedAt + 1000 * (i + 1) }));
    g = r.game;
    events.push(...r.events);
  }
  return { g0, g, events };
}

/** The client saw the opening; after a moment the Battle is `moves` plain moves ahead (2 records each) and they play in order. */
export function catchingUp(moves = 5): Partial<VanguardView> {
  const { g0, g, events } = played(moves);
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 1200, battle: chainState(g, g0, events).battle } } as Partial<VanguardView>;
}

/** Far more than 16 records ahead: the board is shown as it is, nothing is replayed. */
export const farBehind = (): Partial<VanguardView> => catchingUp(12);

/** Reads of the Battle are failing: the board may be behind. */
export function reconnecting(): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  return live(chainState(g0, g0, []), { reconnecting: true });
}

const withPending = (b: Battle, o: Partial<Battle>): Battle => ({ ...b, ...o });

/** Their move was declared and waits for the next slot: the board has not changed. */
export function theirMoveInProgress(attack = false): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const piece = g0.pieces.find((p) => p.army === "us" && targets(g0, p).length)!;
  const r = ok(move(g0, { id: piece.id, to: targets(g0, piece)[0], at: g0.startedAt + 1000 }));
  const s = chainState(r.game, g0, r.events);
  const foe = r.game.pieces.find((p) => p.army === "it" && targets(r.game, p).length)!;
  const step = targets(r.game, foe)[0];
  const to = attack ? s.battle.sq[30] : step.r * 10 + step.c;
  return live(s, { battle: withPending(s.battle, { pendingKind: 1, pendingSeat: 1, pendingPiece: foe.id, pendingTo: to }) });
}

/** You declared a move the hidden rules refuse: when it is applied the turn passes. Press a piece, then a marked square. */
export function lostTurn(): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const r = ok(timeout(g0, g0.deadline + 1));
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 6000, battle: chainState(r.game, g0, r.events).battle } } as Partial<VanguardView>;
}

/** A Battle for the spectator view: a few moves in, nothing public but the squares. */
export const spectated = (): Battle => {
  const { g0, g, events } = played(4);
  return chainState(g, g0, events).battle;
};
export const finished = (): Battle => {
  const { g0, g, events } = played(2);
  return { ...chainState(g, g0, events).battle, status: 3, winner: 0, reason: 3, shown: Array(60).fill(7) };
};
