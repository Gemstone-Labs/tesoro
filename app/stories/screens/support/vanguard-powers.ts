import { chainState, freshGame, type ChainState } from "@/games/vanguard/fixture";
import { act, pass, type Game, type Rank, type Result } from "@/games/vanguard/rules";
import type { VanguardView } from "@/games/vanguard/useVanguardMatch";
import { chainMatch } from "./matches";

/**
 * Chain-driven Vanguard stories for the rank powers: every Battle and Army below comes from the rules engine through
 * `chainState`, so the screen reads the same bytes a real Match would give it.
 */
const T0 = () => Date.now() - 20_000;
const ok = (r: Result) => {
  if (!r.ok) throw new Error(`fixture action refused: ${r.reason}`);
  return r;
};

/** Put the n-th piece of a rank on a square (any piece standing there is removed). */
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

/** Your Engineer, Colonel and Major are in reach of a few hidden Italian pieces; your General of the Army is on the front line. */
const field = (): Game => {
  let g = freshGame(7, T0());
  g = place(g, "us", "3", 6, 4);
  g = place(g, "it", "5", 5, 3);
  g = place(g, "it", "9", 5, 4);
  g = place(g, "it", "B", 5, 5);
  g = place(g, "us", "8", 7, 6);
  g = place(g, "us", "7", 6, 6);
  g = place(g, "us", "10", 6, 2);
  return g;
};

/** Your turn with the powers in reach: tap the Engineer for Blast (its 8 squares are outlined), the Colonel for Rescue, the Major for Dig in, the 10 for Become a Spy. */
export function powerTurn(): Partial<VanguardView> {
  const g = field();
  return live(chainState(g, g, []));
}

/** Their Engineer blows up beside your pieces a moment from now: it flips face up, then the blast shows your pieces to them. */
export function theirBlast(): Partial<VanguardView> {
  const g0 = { ...field(), turn: "it" as const };
  const g1 = place(place(place(g0, "it", "3", 5, 4, 0), "us", "5", 6, 4), "us", "6", 6, 5);
  const r = ok(act(g1, { kind: "blast", id: g1.pieces.find((p) => p.army === "it" && p.rank === "3")!.id, at: g1.startedAt + 1000 }));
  return { ...live(chainState(g1, g1, [])), later: { afterMs: 1500, battle: chainState(r.game, g1, r.events).battle } } as Partial<VanguardView>;
}

/** Their Colonel blows up and their Truck jumps onto its square, face up. */
export function theirRescue(): Partial<VanguardView> {
  let g0: Game = { ...field(), turn: "it" };
  g0 = place(g0, "it", "8", 4, 4);
  const colonel = g0.pieces.find((p) => p.army === "it" && p.rank === "8")!;
  const r = ok(act(g0, { kind: "rescue", id: colonel.id, at: g0.startedAt + 1000 }));
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 1500, battle: chainState(r.game, g0, r.events).battle } } as Partial<VanguardView>;
}

/**
 * They pass. A pass and a face-down Dig in are the same record: whichever it was, this is all you are shown ("Your opponent
 * passed."), with the same board and the same count of missed turns.
 */
export function theirPass(digIn = false): Partial<VanguardView> {
  const g0 = { ...field(), turn: "it" as const };
  const major = g0.pieces.find((p) => p.army === "it" && p.rank === "7")!;
  const r = ok(pass(g0, { at: g0.startedAt + 1000, digIn: digIn ? major.id : undefined }));
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 1500, battle: chainState(r.game, g0, r.events).battle } } as Partial<VanguardView>;
}

/** Reloaded after you dug a Major in and switched your General of the Army: both wear their badge, read from your Army alone. */
export function reloadedWithChanges(): Partial<VanguardView> {
  const g0 = field();
  const major = g0.pieces.find((p) => p.army === "us" && p.rank === "7")!;
  const ten = g0.pieces.find((p) => p.army === "us" && p.rank === "10")!;
  const g = { ...g0, changed: { [major.id]: "dug" as const, [ten.id]: "spy" as const } };
  return live(chainState(g, g0, []));
}

/** You pass on purpose, digging the Major in; a moment later your Army tells you so ("Dug in"), while the Battle shows only a pass. */
export function yourDugIn(): Partial<VanguardView> {
  const g0 = field();
  const major = g0.pieces.find((p) => p.army === "us" && p.rank === "7")!;
  const r = ok(pass(g0, { at: g0.startedAt + 1000, digIn: major.id }));
  const after = chainState(r.game, g0, r.events);
  return { ...live(chainState(g0, g0, [])), later: { afterMs: 1500, battle: after.battle, army: after.armies[0] } } as Partial<VanguardView>;
}

/** The Match is decided: the end panel lists the Major that dug in and the 10 that became a Spy, from the end mask. */
export function endChanged(): Partial<VanguardView> {
  const g0 = field();
  const major = g0.pieces.find((p) => p.army === "us" && p.rank === "7")!;
  const ten = g0.pieces.find((p) => p.army === "it" && p.rank === "10")!;
  const r = ok(pass(g0, { at: g0.startedAt + 1000, digIn: major.id }));
  const end: Game = {
    ...r.game,
    changed: { ...r.game.changed, [ten.id]: "spy" },
    pieces: r.game.pieces.filter((p) => p.id !== ten.id).map((p) => ({ ...p, known: true })),
    winner: "us",
    reason: "cap",
  };
  return live(chainState(end, g0, r.events), { stage: "closing", note: "Saving the result" });
}
