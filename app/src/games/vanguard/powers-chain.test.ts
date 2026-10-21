import { describe, expect, it } from "vitest";
import { decodeRecord, type ArmyAccount, type Battle } from "./decode";
import { pendingOf } from "./catchup";
import { changedPieces } from "./end";
import { chainState, encodeEvent, freshGame } from "./fixture";
import { move, pass, rankOf, type Game, type GameEvent, type Result } from "./rules";
import { canSwitch, powerFor } from "./powers-ui";
import { chainRoster, lookGame, shownLedger, shownPieces, shownTen } from "./view";

const ok = (r: Result) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const T0 = 1_760_000_000_000;
const start = () => freshGame(7, T0);
const ofRank = (g: Game, army: "us" | "it", rank: string, nth = 0) => g.pieces.filter((p) => p.army === army && p.rank === rank)[nth]!;

/** The game after the US Army passes, digging `major` in when given. */
function usPasses(g0: Game, digIn?: number) {
  const r = ok(pass(g0, { at: g0.startedAt + 1000, digIn }));
  return { ...r, state: chainState(r.game, g0, r.events) };
}

describe("a Dig in from the opponent's side: nothing shows", () => {
  const g0 = start();
  const major = ofRank(g0, "us", "7");
  const plain = usPasses(g0);
  const dug = usPasses(g0, major.id);

  it("leaves the public Battle byte for byte what a plain pass leaves", () => {
    expect(dug.state.battle).toEqual(plain.state.battle);
    expect(dug.events.map(encodeEvent)).toEqual(plain.events.map(encodeEvent));
    expect(dug.events.map((e) => e.kind)).toEqual(["pass", "turn"]);
  });

  it("gives the opponent the same pieces, roster, pending view and event line either way", () => {
    const view = (s: typeof plain.state) => ({
      pieces: shownPieces(s.battle, s.armies[1], 1),
      roster: chainRoster(s.battle, 1),
      events: s.battle.ring.map((r) => decodeRecord(r)),
    });
    expect(view(dug.state)).toEqual(view(plain.state));
    const declared = (b: Battle, sealedSlot: number) => ({ ...b, pendingKind: 6, pendingSeat: 0, pendingPiece: sealedSlot });
    // a sealed slot byte is not a piece: whatever it holds, the line and the piece are the same
    expect(pendingOf(declared(dug.state.battle, 0x4c), 1)).toEqual(pendingOf(declared(plain.state.battle, 0xe1), 1));
    expect(pendingOf(declared(dug.state.battle, 0x4c), 1)).toMatchObject({ kind: "pass", mine: false, piece: null, line: "Your opponent is passing…" });
  });

  it("shows the owner their Major as a Landmine with a Major badge, from the Army alone (after a reload)", () => {
    const mine = shownPieces(dug.state.battle, dug.state.armies[0], 0).find((p) => p.id === major.id)!;
    expect(mine).toMatchObject({ rank: "B", up: true, changed: "dug" });
    // the owner's Army bytes are all a reload has: rebuild the account from its private codes
    const reloaded: ArmyAccount = { ...dug.state.armies[0], ranks: [...dug.state.armies[0].ranks] };
    expect(reloaded.ranks[major.id % 30]).toBe(13);
    expect(shownPieces(dug.state.battle, reloaded, 0).find((p) => p.id === major.id)).toMatchObject({ rank: "B", changed: "dug" });
    // and the plain pass left no badge
    expect(shownPieces(plain.state.battle, plain.state.armies[0], 0).some((p) => p.changed)).toBe(false);
  });

  it("never shows the opponent's piece or badge to the other seat, whichever Army is passed in", () => {
    const theirs = shownPieces(dug.state.battle, dug.state.armies[1], 1).find((p) => p.id === major.id)!;
    expect(theirs).toMatchObject({ rank: null, up: false });
    expect(theirs.changed).toBeUndefined();
    // a mismatched account is ignored: the owner's Army read by the other seat yields nothing
    const leaked = shownPieces(dug.state.battle, dug.state.armies[0], 1).find((p) => p.id === major.id)!;
    expect(leaked.changed).toBeUndefined();
    expect(leaked.rank).toBeNull();
  });

  it("plays as a Landmine for the rules the client asks (it never moves, it cannot dig in twice)", () => {
    const g = lookGame(dug.state.battle, dug.state.armies[0], 0);
    const p = g.pieces.find((x) => x.id === major.id)!;
    expect(rankOf(g, p)).toBe("B");
    expect(g.changed[major.id]).toBe("dug");
    expect(powerFor({ ...g, turn: "us" }, p)).toBeNull();
  });
});

describe("Become a Spy", () => {
  const g0 = start();
  const ten = ofRank(g0, "us", "10");
  const mover = g0.pieces.find((p) => p.army === "us" && p.rank !== "B" && p.rank !== "F" && p.rank !== "10" && [1, 2, 4, 6].includes(Number(p.rank)))!;
  const target = (() => {
    const t = [{ r: mover.r - 1, c: mover.c }, { r: mover.r, c: mover.c - 1 }, { r: mover.r, c: mover.c + 1 }].find((q) => q.r >= 0 && q.c >= 0 && q.c < 10 && !g0.pieces.some((p) => p.r === q.r && p.c === q.c));
    return t;
  })();

  it("is offered only to the live, unswitched 10 of the Player's own Army", () => {
    const s = chainState(g0, g0, []);
    const g = lookGame(s.battle, s.armies[0], 0);
    expect(canSwitch(g, g.pieces.find((p) => p.id === ten.id)!)).toBe(true);
    expect(g.pieces.filter((p) => canSwitch(g, p)).map((p) => p.id)).toEqual([ten.id]);
  });

  it("is a badge on the owner's 10 after a reload and nothing more once it is a Spy", () => {
    if (!target) throw new Error("no free square for the test move");
    const r = ok(move(g0, { id: mover.id, to: target, at: g0.startedAt + 1000, switch: true }));
    const s = chainState(r.game, g0, r.events);
    expect(s.armies[0].ranks[ten.id % 30]).toBe(14);
    const mine = shownPieces(s.battle, s.armies[0], 0).find((p) => p.id === ten.id)!;
    expect(mine).toMatchObject({ rank: "1", changed: "spy" });
    const g = lookGame(s.battle, s.armies[0], 0);
    const p = g.pieces.find((x) => x.id === ten.id)!;
    expect(p.rank).toBe("10"); // dealt as a 10
    expect(rankOf(g, p)).toBe("1"); // plays as a Spy
    expect(canSwitch({ ...g, turn: "us" }, p)).toBe(false);
    // the opponent learns nothing: no event, no shown rank, same board as the same move without the switch
    const plain = ok(move(g0, { id: mover.id, to: target, at: g0.startedAt + 1000 }));
    expect(chainState(plain.game, g0, plain.events).battle).toEqual(s.battle);
    expect(shownPieces(s.battle, s.armies[1], 1).find((x) => x.id === ten.id)).toMatchObject({ rank: null, up: false });
  });
});

describe("the power button comes from the rules, for the chain's own game", () => {
  const g0 = { ...start(), turn: "us" as const };
  const s = chainState(g0, g0, []);
  const game = lookGame(s.battle, s.armies[0], 0);
  const kindOf = (rank: string) => powerFor(game, game.pieces.find((p) => p.army === "us" && p.rank === rank)!)?.kind ?? null;

  it("offers Blast to an Engineer, Rescue to a Colonel and Dig in to a Major, and nothing to the rest", () => {
    expect(["3", "8", "7"].map(kindOf)).toEqual(["blast", "rescue", "dig_in"]);
    for (const r of ["1", "2", "4", "5", "6", "9", "10", "B", "F"]) expect(kindOf(r)).toBeNull();
  });

  it("offers no power on a version 5 Battle, which keeps the old rules", () => {
    const old = lookGame({ ...s.battle, rulesVersion: 5 }, s.armies[0], 0);
    for (const r of ["3", "8", "7"]) expect(powerFor(old, old.pieces.find((p) => p.army === "us" && p.rank === r)!)).toBeNull();
    expect(canSwitch(old, old.pieces.find((p) => p.army === "us" && p.rank === "10")!)).toBe(false);
  });

  it("takes the power away after a step, like the rules (it uses the whole turn)", () => {
    const eng = game.pieces.find((p) => p.army === "us" && p.rank === "3")!;
    expect(powerFor({ ...game, movedThisTurn: [eng.id] }, eng)).toBeNull();
    expect(powerFor({ ...game, twoStepActive: true }, eng)).toBeNull();
  });
});

describe("the roster strip counts what the Battle shows", () => {
  const g0 = start();
  const b0 = chainState(g0, g0, []).battle;
  const withShown = (shown: Record<number, number>, dead: number[] = [], over: Partial<Battle> = {}): Battle => {
    const b = { ...b0, shown: [...b0.shown], sq: [...b0.sq], ...over };
    for (const [id, code] of Object.entries(shown)) b.shown[Number(id)] = code;
    for (const id of dead) b.sq[id] = 255;
    return b;
  };
  const cell = (b: Battle, rank: string, tenId: number | null = null) => chainRoster(b, 0, tenId).cells.find((c) => c.rank === rank)!;
  const tenIt = ofRank(g0, "it", "10").id;
  const spyIt = ofRank(g0, "it", "1").id;

  it("says '10 or Spy?' until a 10 is shown", () => {
    expect(chainRoster(b0, 0).tenOrSpy).toBe(true);
    const seen = withShown({ [tenIt]: 10 });
    expect(chainRoster(seen, 0).tenOrSpy).toBe(false);
    expect(cell(seen, "10").left).toBe(1);
  });

  it("stops saying it once the 10 fell, shown as a 10", () => {
    const b = withShown({ [tenIt]: 10 }, [tenIt]);
    expect(chainRoster(b, 0).tenOrSpy).toBe(false);
    expect(cell(b, "10").left).toBe(0);
  });

  it("two Spies shown mean the 10 switched: no 10 left, and the Spies count 1 of 2", () => {
    const b = withShown({ [spyIt]: 1, [tenIt]: 1 });
    const rv = chainRoster(b, 0);
    expect(rv.tenOrSpy).toBe(false);
    expect(cell(b, "10").left).toBe(0);
    expect(cell(b, "1")).toMatchObject({ of: 2, left: 2 });
  });

  it("a 10 this screen saw face up that now shows as a Spy is the switched 10, not an unseen one", () => {
    const b = withShown({ [tenIt]: 1 });
    expect(chainRoster(b, 0).tenOrSpy).toBe(true); // a reload has lost the memory: it can only say 'maybe'
    expect(chainRoster(b, 0, tenIt).tenOrSpy).toBe(false);
    expect(cell(b, "10", tenIt).left).toBe(0);
    expect(cell(b, "1", tenIt)).toMatchObject({ of: 2, left: 2 });
    expect(shownLedger(b, 0, tenIt)[tenIt]).toEqual(["10", "1"]);
  });

  it("remembers which enemy piece is shown as the 10", () => {
    expect(shownTen(b0, 0)).toBeNull();
    expect(shownTen(withShown({ [tenIt]: 10 }), 0)).toBe(tenIt);
    expect(shownTen(withShown({ [ofRank(g0, "us", "10").id]: 10 }), 0)).toBeNull(); // your own army is not read
  });

  it("survives a ring wrap: dead pieces stay published, so the count does not depend on any record", () => {
    const dead = g0.pieces.filter((p) => p.army === "it" && p.rank === "4").map((p) => p.id);
    const shown = Object.fromEntries(dead.map((id) => [id, 4]));
    const quiet = withShown(shown, dead, { eventSeq: 400 });
    const noisy = { ...quiet, ring: Array.from({ length: 16 }, (_, i) => encodeEvent({ seq: 384 + i, kind: "pass", army: "us" } as GameEvent)) };
    expect(chainRoster(noisy, 0)).toEqual(chainRoster(quiet, 0));
    expect(cell(quiet, "4").left).toBe(cell(b0, "4").left - dead.length);
  });

  it("draws pieces a Blast showed from the Battle's published ranks, with no record needed", () => {
    const hidden = g0.pieces.filter((p) => p.army === "it").slice(0, 2);
    const b = withShown({ [hidden[0].id]: 5, [hidden[1].id]: 6 });
    expect(shownPieces(b, null, 0).filter((p) => p.army === "it" && p.up).map((p) => p.rank)).toEqual(expect.arrayContaining(["5", "6"]));
  });
});

describe("the end panel reads the end mask", () => {
  const g0 = start();
  const major = ofRank(g0, "us", "7");
  const ten = ofRank(g0, "it", "10");
  // the US Major dug in, the Italian 10 switched, then the Italian 10 died as a Spy; the Match is decided on the cap
  const r = ok(pass(g0, { at: g0.startedAt + 1000, digIn: major.id }));
  const end: Game = {
    ...r.game,
    changed: { ...r.game.changed, [ten.id]: "spy" },
    pieces: r.game.pieces.filter((p) => p.id !== ten.id).map((p) => ({ ...p, known: true })),
    winner: "us",
    reason: "cap",
  };
  const s = chainState(end, g0, r.events);

  it("is empty while the Match is on, even when pieces changed", () => {
    const live = chainState(r.game, g0, r.events).battle;
    expect(live.endMask).toBe(0n);
    expect(changedPieces(live, 0)).toEqual([]);
  });

  it("lists the dug-in Major and the switched 10 for what they were, the dead one included, as 'Yours' or the opponent's", () => {
    expect(s.battle.endMask).toBe((1n << BigInt(major.id)) | (1n << BigInt(ten.id)));
    expect(changedPieces(s.battle, 0)).toEqual(
      [
        { id: ten.id, mine: false, text: "General of the Army, now a Spy" },
        { id: major.id, mine: true, text: "Major, dug in" },
      ].sort((a, b) => a.id - b.id),
    );
    expect(changedPieces(s.battle, 1).map((c) => c.mine)).toEqual([true, false]);
  });

  it("draws the pieces with their badge once the Match is over, whoever owns them, and no 'seen by the enemy' glow", () => {
    const ps = shownPieces(s.battle, s.armies[1], 1);
    expect(ps.find((p) => p.id === major.id)).toMatchObject({ rank: "B", changed: "dug" });
    expect(ps.some((p) => p.exposed)).toBe(false);
  });
});

describe("seen by the enemy", () => {
  it("glows an own piece the Battle published (a Blast, a Spotted Truck) and no piece the enemy has not seen", () => {
    const g0 = start();
    const near = g0.pieces.find((p) => p.army === "us")!;
    // an Italian Blast showed one US piece: the Battle publishes its rank
    const s = chainState({ ...g0, pieces: g0.pieces.map((p) => (p.id === near.id ? { ...p, known: true } : p)) }, g0, []);
    const ps = shownPieces(s.battle, s.armies[0], 0);
    expect(ps.filter((p) => p.exposed).map((p) => p.id)).toEqual([near.id]);
    // from the other seat, the enemy's piece is face up but is not "my exposed piece"
    expect(shownPieces(s.battle, s.armies[1], 1).find((p) => p.id === near.id)).toMatchObject({ up: true });
    expect(shownPieces(s.battle, s.armies[1], 1).some((p) => p.exposed)).toBe(false);
  });

  it("an event for a Blast reads back whole through the ring", () => {
    const e: GameEvent = { seq: 3, kind: "blast", id: 33, at: { r: 5, c: 4 }, shown: [{ id: 2, rank: "5" }, { id: 9, rank: "F" }] };
    expect(decodeRecord(encodeEvent(e))).toEqual(e);
    const rescue: GameEvent = { seq: 4, kind: "rescue", colonel: 41, truck: 55, from: { r: 8, c: 8 }, to: { r: 6, c: 3 } };
    expect(decodeRecord(encodeEvent(rescue))).toEqual(rescue);
    for (const x of [{ seq: 5, kind: "dug_in", army: "it", id: 4 }, { seq: 6, kind: "pass", army: "us" }, { seq: 7, kind: "switched", id: 31 }] as GameEvent[]) {
      expect(decodeRecord(encodeEvent(x))).toEqual(x);
    }
  });
});
