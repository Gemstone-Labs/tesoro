import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { ArmyAccount, Battle } from "./decode";
import { chainRoster, depotsFor, hitSide, lookGame, shownPieces, toView } from "./view";
import { targets } from "./rules";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

/** A live Battle: US pieces 30-59 on rows 7-9, Italian 0-29 on rows 0-2; everything hidden but the given reveals. */
function battle(over: Partial<Battle> = {}, shown: Record<number, number> = {}): Battle {
  const sq = Array.from({ length: 60 }, (_, i) => (i < 30 ? i : i + 40));
  const sh = Array(60).fill(0);
  for (const [id, code] of Object.entries(shown)) sh[Number(id)] = code;
  return {
    matchId: 1n, moved: 0n, startDeadline: 0, entropyDeadline: 0, deadline: 1000, startedAt: 900, eventSeq: 0, turnNo: 0, moves: 0, ring: [],
    tesoroMatch: key(1), players: [key(2), key(3)], sq, shown: sh, trail: Array.from({ length: 60 }, () => [0, 0, 0, 0, 0, 0]), trailLen: Array(60).fill(0),
    bump: 0, authorityBump: 0, usSeat: 0, status: 2, finalized: 0, permissioned: 1, winner: 255, reason: 255, turn: 0, stepsLeft: 1, twoStepActive: 0, stormDone: 0,
    twoStep: [0, 0], timeouts: [0, 0], depotClaimed: [0, 0],
    layoutVersion: 2, rulesVersion: 4, setupDeadline: 0, capDeadline: 0, payer: key(4), oracleQueue: key(5), moveCap: 200, capSecs: 900, turnSecs: 5, graceSecs: 1,
    openingGraceSecs: 10, resolveSlackSecs: 2, stormFrom: 10, stormTo: 18, pendingKind: 0, pendingPiece: 0, pendingTo: 0, pendingSeat: 0, actionSeq: 0, pendingSlot: 0n, pendingTime: 0, dealSlot: 0n, endMask: 0n,
    ...over,
  };
}

/** An Army whose 30 slots hold rank codes 1..12 repeating, so every piece has a distinct-enough rank to leak. */
const army = (side: number, seat: number): ArmyAccount => ({
  bump: 0, table: key(1), seat, player: key(2 + seat), side, ranks: Array.from({ length: 30 }, (_, i) => (i % 12) + 1), fuel: 0, truckTurn: -9, moves: 0, sealKey: new Uint8Array(32), contributed: false, dealt: true,
});

describe("merging the public Battle with the Player's own Army", () => {
  it("shows own pieces face up with their ranks and enemy pieces face down", () => {
    const b = battle();
    const ps = shownPieces(b, army(0, 0), 0);
    const own = ps.filter((p) => p.army === "us");
    const foe = ps.filter((p) => p.army === "it");
    expect(own).toHaveLength(20 + 10);
    expect(own.every((p) => p.up && p.rank !== null)).toBe(true);
    expect(own.find((p) => p.id === 30)?.rank).toBe("1");
    expect(foe.every((p) => !p.up && p.rank === null)).toBe(true);
  });

  it("never shows an enemy rank before it is public, whatever else is passed in", () => {
    const b = battle();
    // the opponent's private Army must not even be usable: a mismatched account is ignored
    const ps = shownPieces(b, army(1, 1), 0);
    expect(ps.filter((p) => p.army === "it").every((p) => p.rank === null && !p.up)).toBe(true);
    expect(ps.filter((p) => p.army === "us").every((p) => !p.up)).toBe(true);
    expect(JSON.stringify(ps.filter((p) => p.army === "it"))).not.toMatch(/"rank":"/);
  });

  it("shows an enemy piece once the Battle publishes its rank, and keeps it that way", () => {
    const b = battle({}, { 5: 10, 12: 11 });
    const foe = shownPieces(b, army(0, 0), 0).filter((p) => p.army === "it");
    expect(foe.find((p) => p.id === 5)).toMatchObject({ up: true, rank: "10" });
    expect(foe.find((p) => p.id === 12)).toMatchObject({ up: true, rank: "B" });
    expect(foe.filter((p) => p.up)).toHaveLength(2);
  });

  it("works the same for the Italian seat, on the other side of the table", () => {
    const b = battle({ usSeat: 1 });
    const ps = shownPieces(b, army(1, 0), 0);
    expect(ps.filter((p) => p.army === "it").every((p) => p.up && p.rank)).toBe(true);
    expect(ps.filter((p) => p.army === "us").every((p) => !p.up && p.rank === null)).toBe(true);
  });

  it("leaves out pieces that are off the board", () => {
    const sq = battle().sq;
    sq[3] = 255;
    expect(shownPieces(battle({ sq }, { 3: 4 }), army(0, 0), 0).some((p) => p.id === 3)).toBe(false);
  });
});

describe("the table is turned for the Italian Player", () => {
  it("puts your own army at the bottom whichever side you play", () => {
    const us = shownPieces(battle(), army(0, 0), 0).filter((p) => p.army === "us");
    expect(Math.min(...us.map((p) => p.r))).toBe(7);
    const it = shownPieces(battle({ usSeat: 1 }), army(1, 0), 0).filter((p) => p.army === "it");
    expect(Math.min(...it.map((p) => p.r))).toBe(7);
    expect(Math.max(...it.map((p) => p.r))).toBe(9);
  });

  it("turns squares half way round and back", () => {
    expect(toView({ r: 0, c: 0 }, "it")).toEqual({ r: 9, c: 9 });
    expect(toView({ r: 7, c: 3 }, "it")).toEqual({ r: 2, c: 6 });
    expect(toView({ r: 7, c: 3 }, "us")).toEqual({ r: 7, c: 3 });
  });

  it("turns the depots and keeps yours to raid in the enemy base", () => {
    const d = depotsFor(battle({ depotClaimed: [0, 1] }), "it");
    const mine = d.find((x) => x.raider === "it")!;
    expect(mine.r).toBeLessThan(5); // an Italian raids the depot in the US base, which is at the top of their table
    expect(mine.claimed).toBe(true);
    expect(d.find((x) => x.raider === "us")!.claimed).toBe(false);
  });

  it("flips the side a piece was hit from", () => {
    const from = { r: 5, c: 2 };
    const to = { r: 5, c: 3 };
    expect(hitSide(from, to, "us")).toBe("left");
    expect(hitSide(from, to, "it")).toBe("right");
    expect(hitSide({ r: 4, c: 2 }, { r: 5, c: 2 }, "us")).toBe("top");
    expect(hitSide({ r: 4, c: 2 }, { r: 5, c: 2 }, "it")).toBe("bottom");
  });
});

/** The strip's count of each enemy rank still standing. */
const leftOf = (b: Battle, seat: number) => Object.fromEntries(chainRoster(b, seat).cells.map((c) => [c.rank, c.left]));

describe("the roster strip comes from the piece list", () => {
  it("counts the enemy ranks still standing, never the ring", () => {
    const sq = battle().sq;
    sq[8] = 255; // an Italian piece that left, shown as a 7
    const shown = { 8: 7, 20: 12 };
    const left = leftOf(battle({ sq }, shown), 0);
    expect(left["7"]).toBe(1);
    expect(left["10"]).toBe(1);
    expect(left.F).toBe(1);
    expect(left.B).toBe(2);
  });

  it("counts a revealed piece that is still on the board as standing", () => {
    expect(leftOf(battle({}, { 20: 12 }), 0).F).toBe(1);
  });

  it("works from the Italian seat too", () => {
    const sq = battle({ usSeat: 1 }).sq;
    sq[35] = 255;
    expect(leftOf(battle({ usSeat: 1, sq }, { 35: 9 }), 0)["9"]).toBe(0);
  });
});

describe("legal moves for highlighting", () => {
  it("marks the squares an own piece can reach, and an enemy in the way as an attack", () => {
    const sq = battle().sq;
    sq[42] = 61; // a US piece at (6,1)
    sq[10] = 51; // an Italian piece at (5,1)
    const b = battle({ sq });
    const g = lookGame(b, army(0, 0), 0);
    const piece = g.pieces.find((p) => p.id === 42)!;
    const t = targets(g, piece);
    expect(t.find((s) => s.r === 5 && s.c === 1)?.attack).toBe(true);
  });
});
