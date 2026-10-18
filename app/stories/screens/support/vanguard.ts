import { chainState, freshGame, type ChainState } from "@/games/vanguard/fixture";
import { botMove } from "@/games/vanguard/practice/bot";
import { move, seeded, targets, timeout, type Game, type GameEvent, type Rank, type Result } from "@/games/vanguard/rules";
import type { VanguardView } from "@/games/vanguard/useVanguardMatch";
import { chainMatch } from "./matches";

const T0 = () => Date.now() - 20_000;
const ok = (r: Result) => {
  if (!r.ok) throw new Error(`fixture action refused: ${r.reason}`);
  return r;
};

/** Move one piece of an army (by rank) onto a square, for a ready-made contact. */
const place = (g: Game, army: "us" | "it", rank: Rank, r: number, c: number, nth = 0): Game => {
  const p = g.pieces.filter((x) => x.army === army && x.rank === rank)[nth];
  if (!p) return g;
  const clear = g.pieces.filter((x) => !(x.r === r && x.c === c) || x.id === p.id);
  return { ...g, pieces: clear.map((x) => (x.id === p.id ? { ...x, r, c, trail: [`${r},${c}`] } : x)) };
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

/** Opening position, the US Army to move (you). */
export function yourTurn(): Partial<VanguardView> {
  const g = freshGame(7, T0());
  return live(chainState(g, g, []));
}

/** After your first move the Italian Army is to act. */
export function theirTurn(): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const piece = g0.pieces.find((p) => p.army === "us" && targets(g0, p).length)!;
  const r = ok(move(g0, { id: piece.id, to: targets(g0, piece)[0], at: g0.startedAt + 1000 }));
  return live(chainState(r.game, g0, r.events));
}

/** Their turn, and a moment later they move: the new Battle arrives and the move slides in. */
export function theirMove(): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const piece = g0.pieces.find((p) => p.army === "us" && targets(g0, p).length)!;
  const r1 = ok(move(g0, { id: piece.id, to: targets(g0, piece)[0], at: g0.startedAt + 1000 }));
  const m = botMove(r1.game, seeded(5))!;
  const r2 = ok(move(r1.game, { id: m.id, to: m.to, at: g0.startedAt + 2000 }));
  const history: GameEvent[] = [...r1.events];
  return { ...live(chainState(r1.game, g0, history)), later: { afterMs: 1500, battle: chainState(r2.game, g0, [...history, ...r2.events]).battle } } as Partial<VanguardView>;
}

const contact = (seed = 7): Game => {
  let g = freshGame(seed, T0());
  g = place(g, "us", "9", 6, 0);
  g = place(g, "it", "7", 5, 0);
  g = place(g, "us", "4", 6, 4);
  g = place(g, "it", "8", 5, 4);
  return g;
};

/** Pieces in contact and it is their turn: a moment later their 8 hits your 4 and your 4 falls. */
export function fight(): Partial<VanguardView> {
  const g0 = { ...contact(), turn: "it" as const };
  const att = g0.pieces.find((p) => p.army === "it" && p.rank === "8" && p.r === 5 && p.c === 4)!;
  const r = ok(move(g0, { id: att.id, to: { r: 6, c: 4 }, at: g0.startedAt + 1000 }));
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 1500, battle: chainState(r.game, g0, r.events).battle } } as Partial<VanguardView>;
}

/** You attack their 7 with your General: pick the 9, tap the marked square. Nothing is sent, so only the opening shows. */
export function yourAttack(): Partial<VanguardView> {
  const g0 = contact();
  return live(chainState(g0, g0, []));
}

/** The Dust Storm blows at the end of their turn: a moment later the Battle shows the drifted pieces. */
export function storm(): Partial<VanguardView> {
  const g0 = { ...freshGame(7, T0()), stormAt: 1, turn: "it" as const, turnNo: 0 };
  const m = botMove(g0, seeded(3))!;
  const r = ok(move(g0, { id: m.id, to: m.to, at: g0.startedAt + 1000 }));
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 1500, battle: chainState(r.game, g0, r.events).battle } } as Partial<VanguardView>;
}

/** Your Supply Truck is captured: the Match is over, every piece face up, the result being saved. */
export function end(): Partial<VanguardView> {
  let g0 = freshGame(7, T0());
  g0 = place(g0, "it", "F", 6, 5);
  g0 = place(g0, "us", "5", 6, 4);
  g0 = { ...g0, turn: "us" };
  const r = ok(move(g0, { id: g0.pieces.find((p) => p.army === "us" && p.rank === "5")!.id, to: { r: 6, c: 5 }, at: g0.startedAt + 1000 }));
  const s = chainState(r.game, g0, r.events);
  return live(s, { stage: "closing", note: "Saving the result" });
}

/** You lose on time: the third timeout in a row. */
export function endTimeouts(): Partial<VanguardView> {
  let g = freshGame(7, T0());
  const g0 = g;
  const events: GameEvent[] = [];
  for (let i = 0; i < 5 && !g.winner; i++) {
    const r = ok(timeout(g, g.deadline + 1));
    g = r.game;
    events.push(...r.events);
  }
  return live(chainState(g, g0, events), { stage: "closing", note: "Saving the result" });
}

/** You play the Italian Army: the board is turned so your own army is at the bottom; the US Army moves first, and a moment later its move slides in. */
export function asItaly(): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const m = botMove(g0, seeded(5))!;
  const r = ok(move(g0, { id: m.id, to: m.to, at: g0.startedAt + 1000 }));
  const first = chainState(g0, g0, [], { usSeat: 1 });
  const next = chainState(r.game, g0, r.events, { usSeat: 1 });
  return { ...live(first, { seat: 0, army: first.armies[0] }), later: { afterMs: 1500, battle: next.battle } } as Partial<VanguardView>;
}

/** The same Italian view in contact: their General (9) attacks your Italian 7 and wins. */
export function italyFight(): Partial<VanguardView> {
  const g0 = { ...contact(), turn: "us" as const };
  const att = g0.pieces.find((p) => p.army === "us" && p.rank === "9" && p.r === 6 && p.c === 0)!;
  const r = ok(move(g0, { id: att.id, to: { r: 5, c: 0 }, at: g0.startedAt + 1000 }));
  const first = chainState(g0, g0, [], { usSeat: 1 });
  return { ...live(first, { seat: 0, army: first.armies[0] }), later: { afterMs: 1500, battle: chainState(r.game, g0, r.events, { usSeat: 1 }).battle } } as Partial<VanguardView>;
}
