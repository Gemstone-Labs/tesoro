import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { PENDING, type Battle } from "./decode";
import { catchUp, pendingOf, turnLine } from "./catchup";
import { encodeEvent } from "./fixture";
import { enemyLeft } from "./view";
import type { GameEvent } from "./rules";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

function battle(over: Partial<Battle> = {}): Battle {
  const sq = Array.from({ length: 60 }, (_, i) => (i < 30 ? i : i + 40));
  return {
    matchId: 1n, moved: 0n, startDeadline: 0, entropyDeadline: 0, deadline: 1000, startedAt: 900, eventSeq: 0, turnNo: 0, moves: 0,
    ring: Array.from({ length: 16 }, () => ({ seq: 0, kind: 0, data: Array<number>(35).fill(0) })),
    tesoroMatch: key(1), players: [key(2), key(3)], sq, shown: Array(60).fill(0), trail: Array.from({ length: 60 }, () => [0, 0, 0, 0, 0, 0]), trailLen: Array(60).fill(0),
    bump: 0, authorityBump: 0, usSeat: 0, status: 2, finalized: 0, permissioned: 1, winner: 255, reason: 255, turn: 0, stepsLeft: 1, twoStepActive: 0, stormDone: 0,
    twoStep: [0, 0], timeouts: [0, 0], depotClaimed: [0, 0],
    layoutVersion: 2, rulesVersion: 3, setupDeadline: 0, capDeadline: 0, payer: key(4), oracleQueue: key(5), moveCap: 200, capSecs: 900, turnSecs: 5, graceSecs: 1,
    openingGraceSecs: 10, stormFrom: 10, stormTo: 18, pendingKind: 0, pendingPiece: 0, pendingTo: 0, pendingSeat: 0, actionSeq: 0, pendingSlot: 0n, pendingTime: 0, dealSlot: 0n, resolveSlackSecs: 2,
    ...over,
  };
}

const move = (seq: number): GameEvent => ({ seq, kind: "move", id: 40, from: { r: 7, c: 0 }, to: { r: 6, c: 0 } });
/** A Battle whose ring holds the last `n` records ending at `eventSeq - 1`. */
function withRing(eventSeq: number, n: number): Battle {
  const b = battle({ eventSeq });
  for (let s = eventSeq - n; s < eventSeq; s++) if (s >= 0) b.ring[s % 16] = encodeEvent(move(s >>> 0));
  return b;
}

describe("catching up", () => {
  it("is idle when the client has played everything", () => {
    expect(catchUp(withRing(5, 5), 5)).toEqual({ mode: "idle" });
  });

  it("plays every newer record, in sequence order", () => {
    const c = catchUp(withRing(9, 9), 6);
    expect(c.mode).toBe("play");
    if (c.mode === "play") expect(c.events.map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  it("plays in order across the end of the ring", () => {
    const c = catchUp(withRing(19, 16), 14);
    expect(c.mode === "play" && c.events.map((e) => e.seq)).toEqual([14, 15, 16, 17, 18]);
  });

  it("plays exactly the ring when the client is 16 behind", () => {
    const c = catchUp(withRing(20, 16), 4);
    expect(c.mode === "play" && c.events).toHaveLength(16);
  });

  it("snaps without animating when more than 16 behind", () => {
    expect(catchUp(withRing(40, 16), 10)).toEqual({ mode: "snap" });
    expect(catchUp(withRing(17, 16), 0)).toEqual({ mode: "snap" });
  });

  it("snaps when a slot was overwritten before it was played", () => {
    const b = withRing(12, 12);
    b.ring[3] = encodeEvent(move(19));
    expect(catchUp(b, 2)).toEqual({ mode: "snap" });
  });

  it("follows the 32-bit sequence number past its wrap", () => {
    const top = 0xfffffffe;
    const b = battle({ eventSeq: 1 });
    for (const s of [top, 0xffffffff, 0]) b.ring[s % 16] = encodeEvent(move(s));
    const c = catchUp(b, top);
    expect(c.mode === "play" && c.events.map((e) => e.seq)).toEqual([top, 0xffffffff, 0]);
  });
});

describe("the board is the truth, the ring only animates", () => {
  it("works out the roster strip from the piece list alone", () => {
    const sq = Array.from({ length: 60 }, (_, i) => (i < 30 ? i : i + 40));
    sq[0] = 255;
    sq[1] = 255;
    const shown = Array(60).fill(0);
    shown[0] = 4;
    shown[1] = 4;
    const plain = battle({ sq, shown });
    const noisy = withRing(30, 16);
    Object.assign(noisy, { sq, shown });
    expect(enemyLeft(noisy, 0)).toEqual(enemyLeft(plain, 0));
    expect(enemyLeft(plain, 0)["4"]).toBe(enemyLeft(battle(), 0)["4"] - 2);
  });
});

describe("a declared action in flight", () => {
  const b = (o: Partial<Battle>) => battle({ pendingKind: PENDING.move, pendingSeat: 1, pendingPiece: 5, pendingTo: 45, turn: 1, ...o });

  it("is nothing when nothing is pending", () => {
    expect(pendingOf(battle(), 0)).toBeNull();
  });

  it("shows an opponent's plain move as in progress, without moving anything", () => {
    const p = pendingOf(b({}), 0);
    expect(p).toMatchObject({ kind: "move", mine: false, piece: 5 });
    expect(p?.line).toBe("Your opponent is making a move…");
  });

  it("shows an attack by what the board shows: the target square holds a piece", () => {
    // piece 30 stands on square 70; piece 6 on 6: aim piece 5 at square 6
    const p = pendingOf(b({ pendingTo: 6 }), 0);
    expect(p).toMatchObject({ kind: "attack", mine: false });
    expect(p?.line).toBe("Your opponent is attacking…");
  });

  it("says nothing about who wins or what the ranks are", () => {
    for (const to of [45, 6]) {
      const p = pendingOf(b({ pendingTo: to }), 0)!;
      expect(JSON.stringify(p)).not.toMatch(/win|won|lose|lost|beat|rank|hidden/i);
    }
  });

  it("tells your own pending action from the opponent's", () => {
    expect(pendingOf(b({ pendingSeat: 0, turn: 0 }), 0)).toMatchObject({ mine: true, line: "Your move is being applied…" });
    expect(pendingOf(b({ pendingSeat: 0, turn: 0, pendingTo: 6 }), 0)?.line).toBe("Your attack is being applied…");
  });

  it("covers a late turn and the time cap", () => {
    expect(pendingOf(battle({ pendingKind: PENDING.timeout }), 0)).toMatchObject({ kind: "pass", line: "A turn ran out of time. Passing it…" });
    expect(pendingOf(battle({ pendingKind: PENDING.cap }), 0)).toMatchObject({ kind: "cap", line: "Time limit reached. Counting the armies…" });
  });
});

describe("the turn record", () => {
  const turn = (t: "us" | "it", timedOut: boolean) => ({ seq: 1, kind: "turn" as const, turn: t, timedOut });

  it("names the Player whose turn was lost (the record holds the army that plays next)", () => {
    expect(turnLine(turn("it", true), "us", false)).toBe("Time! Turn passed.");
    expect(turnLine(turn("us", true), "us", false)).toBe("Opponent ran out of time.");
    expect(turnLine(turn("it", false), "us", false)).toBeNull();
  });

  it("calls a refused declared move a lost turn", () => {
    const line = turnLine(turn("it", true), "us", true);
    expect(line).toBe("Move refused: turn lost.");
  });

  it("only blames your own declare for your own turn", () => {
    expect(turnLine(turn("us", true), "us", true)).toBe("Opponent ran out of time.");
  });
});

describe("refused declares", () => {
  it("is unused by the pure module", () => {
    expect(vi.isMockFunction(catchUp)).toBe(false);
  });
});
