import { chainState, freshGame } from "@/games/vanguard/fixture";
import { botMove } from "@/games/vanguard/practice/bot";
import { CAP_MS, move, seeded, targets, timeout, type EndReason, type Game, type GameEvent, type Result } from "@/games/vanguard/rules";
import type { VanguardView } from "@/games/vanguard/useVanguardMatch";
import { chainMatch } from "./matches";

const T0 = () => Date.now() - 20_000;
const ok = (r: Result) => {
  if (!r.ok) throw new Error(`fixture action refused: ${r.reason}`);
  return r;
};

const live = (s: ReturnType<typeof chainState>, o: Partial<VanguardView> = {}): Partial<VanguardView> => ({
  stage: "live",
  match: chainMatch("vanguard", "active"),
  seat: 0,
  battle: s.battle,
  army: s.armies[0],
  turnSeenAt: Date.now(),
  ...o,
});

/** Both sides have moved once: an ordinary turn of yours, the 5 second ring running from `seenAgo` ms ago. */
function midMatch(seenAgo: number, tweak: (g: Game, start: Game, events: GameEvent[]) => { g: Game; events: GameEvent[] } = (g, _s, e) => ({ g, events: e })): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const mine = g0.pieces.find((p) => p.army === "us" && targets(g0, p).length)!;
  const r1 = ok(move(g0, { id: mine.id, to: targets(g0, mine)[0], at: g0.startedAt + 1000 }));
  const m = botMove(r1.game, seeded(5))!;
  const r2 = ok(move(r1.game, { id: m.id, to: m.to, at: g0.startedAt + 2000 }));
  const t = tweak(r2.game, g0, [...r1.events, ...r2.events]);
  return live(chainState(t.g, g0, t.events), { turnSeenAt: Date.now() - seenAgo });
}

/** The opening turn: the ring stays full while the first mover loads, then runs. */
export const ringOpening = (): Partial<VanguardView> => live(chainState(freshGame(7, T0()), freshGame(7, T0()), []));
/** Your turn, 3.5 seconds in: the ring is nearly out and turns amber. */
export const ringLow = (): Partial<VanguardView> => midMatch(3500);
/** Your turn, just begun: the ring is full. */
export const ringFull = (): Partial<VanguardView> => midMatch(0);

/** You let your clock run out twice, they once: "Missed 2 of 3" is amber, "Missed 1 of 3" is quiet. */
export function missedCounts(): Partial<VanguardView> {
  return midMatch(500, (g) => ({ g: { ...g, timeouts: { us: 2, it: 1 } }, events: [] }));
}

/** The match ended on `reason`; `winner` is "us" (you), "it" or "draw". */
function ended(reason: EndReason, winner: "us" | "it" | "draw", prep: (g: Game) => Game = (g) => g): Partial<VanguardView> {
  const g0 = freshGame(7, T0());
  const start = prep(g0);
  const cap = reason === "cap" ? ok(timeout(start, start.startedAt + CAP_MS + 5000)) : null;
  const g = cap ? cap.game : { ...start, winner, reason, pieces: start.pieces.map((p) => ({ ...p, known: true })) };
  return live(chainState(g, start, cap ? cap.events : []), { stage: "closing", note: "Saving the result" });
}

const without = (army: "us" | "it", rank: string) => (g: Game): Game => {
  const out = g.pieces.find((p) => p.army === army && p.rank === rank);
  return { ...g, pieces: g.pieces.filter((p) => p !== out) };
};

export const endTruckWon = (): Partial<VanguardView> => ended("truck", "us");
export const endTruckLost = (): Partial<VanguardView> => ended("truck", "it");
export const endStuckWon = (): Partial<VanguardView> => ended("stuck", "us");
export const endStuckLost = (): Partial<VanguardView> => ended("stuck", "it");
/** They let their clock run out three turns in a row. */
export const endTimeoutsWon = (): Partial<VanguardView> => ended("timeouts", "us");
/** Your clock ran out three turns in a row. */
export const endTimeoutsLost = (): Partial<VanguardView> => ended("timeouts", "it");
/** The 15 minutes are up and you have the stronger army left. */
export const endCapWon = (): Partial<VanguardView> => ended("cap", "us", without("it", "9"));
export const endCapLost = (): Partial<VanguardView> => ended("cap", "it", without("us", "9"));
/** The 15 minutes are up with equal armies: both entries come back. */
export const endCapDrawn = (): Partial<VanguardView> => ended("cap", "draw");
/** Nobody started in time: the Match is cancelled and both entries come back. */
export function endCancelled(): Partial<VanguardView> {
  const v = ended("cap", "draw");
  return { ...v, battle: { ...v.battle!, status: 4, winner: 255, reason: 255 } };
}

/** The same endings on the result screen, after the Pot is paid. */
export const settledAs = (v: Partial<VanguardView>): Partial<VanguardView> => ({ ...v, stage: "settled" });
