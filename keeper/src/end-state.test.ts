import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { CAPTURE_GIVE_UP_SECS, _resetCaptured, burstEndState, duelEndState, holdemEndState, resetMayProceed, vanguardEndState } from "./end-state.ts";

const match = Keypair.generate().publicKey;

const duel: any = { startsAt: 100, track: { lo: [1n, 2n], hi: [3n, 4n], seen: [true, false], last: 3n, lastCol: 1 }, revealed: [[1, 255], [2, 3]], scores: [4, 5], winner: 1 };
const holdem: any = {
  winner: 0,
  stacks: [900n, 1100n],
  lastHand: { handNo: 7, result: 1, pot: 200n, showdown: false, shown: [[3, 4], [5, 6]], board: [1, 2, 3, 52, 52] },
};
const burst: any = { tesoroMatch: match, epoch: 3, ring: [{ state: 2, tesoroMatch: match, epoch: 3 }], startSlot: 9, finalScores: [10, 20], finalMoves: [3, 4], reason: 2, logs: [{ seed: 5n, seedHash: Uint8Array.of(1, 2), startSlot: 9, moves: Uint8Array.of(7), offsets: Uint8Array.of(0, 1) }] };

describe("end state per game", () => {
  it("Trading Duel keeps picks, line range and scores; a Match that never started keeps nothing", () => {
    const s: any = duelEndState(duel);
    assert.deepEqual(s.picks, [[1, 255], [2, 3]]);
    assert.deepEqual(s.track.lo, ["1", "2"]);
    assert.deepEqual(s.scores, [4, 5]);
    assert.equal(duelEndState({ ...duel, startsAt: 0 }), null);
  });
  it("Hold'em shows the board without hidden cards, and hands only after a showdown", () => {
    const folded: any = holdemEndState(holdem);
    assert.deepEqual(folded.board, [1, 2, 3]);
    assert.equal(folded.shown, null);
    assert.equal(JSON.stringify(folded).includes("[3,4]"), false);
    const shown: any = holdemEndState({ ...holdem, lastHand: { ...holdem.lastHand, showdown: true } });
    assert.deepEqual(shown.shown, [[3, 4], [5, 6]]);
  });
  it("Block Burst keeps the final scores and, once closed, the move log", () => {
    const s: any = burstEndState(burst);
    assert.deepEqual(s.scores, [10, 20]);
    assert.equal(s.log.seed, "5");
    assert.equal(s.log.moves, "07");
    assert.equal(burstEndState({ ...burst, startSlot: 0 }), null);
    assert.equal((burstEndState({ ...burst, logs: [] }) as any).log, null);
  });
  it("Vanguard keeps the public end board and the end mask, and nothing for a Match that was never dealt", () => {
    const battle: any = { usSeat: 1, winner: 0, reason: 0, moves: 12, turnNo: 20, sq: [5, 255], shown: [3, 12], endMask: (1n << 40n) | 8n, depotClaimed: [0, 1], players: [match, match] };
    const s: any = vanguardEndState(battle);
    assert.deepEqual([s.game, s.usSeat, s.winner, s.moves], ["vanguard", 1, 0, 12]);
    assert.deepEqual([s.sq, s.shown, s.endMask], [[5, 255], [3, 12], ((1n << 40n) | 8n).toString()]);
    assert.equal(vanguardEndState({ ...battle, usSeat: 255 }), null);
    // no seat account field can be in it: the capture takes the Battle alone
    assert.equal(JSON.stringify(s).includes("ranks"), false);
  });
  it("is JSON, with no bigint or bytes left", () => {
    const vg: any = { usSeat: 0, winner: 1, reason: 2, moves: 1, turnNo: 2, sq: [1], shown: [2], endMask: 3n, depotClaimed: [0, 0], players: [match, match] };
    for (const s of [duelEndState(duel), holdemEndState(holdem), burstEndState(burst), vanguardEndState(vg)]) JSON.stringify(s);
  });
});

describe("capture before reset", () => {
  beforeEach(() => _resetCaptured());
  const cap = (table = duel) => ({ tesoroMatch: match, epoch: 3, fn: duelEndState, table });

  it("writes the end state first, and only then lets the reset go", async () => {
    const order: string[] = [];
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      order.push(fn);
      assert.equal((args.p as any).match_address, match.toBase58());
      assert.equal((args.p as any).epoch, 3);
      return true;
    };
    const ok = await resetMayProceed(cap(), 40, rpc);
    order.push("reset");
    assert.equal(ok, true);
    assert.deepEqual(order, ["record_end_state", "reset"]);
  });

  it("holds the reset while the database fails, then lets it go after the give-up time", async () => {
    const rpc = async () => {
      throw new Error("down");
    };
    assert.equal(await resetMayProceed(cap(), 40, rpc), false);
    assert.equal(await resetMayProceed(cap(), CAPTURE_GIVE_UP_SECS, rpc), true);
  });

  it("does not write twice, and does not wait when no database is configured", async () => {
    let calls = 0;
    const rpc = async () => (calls++, true);
    await resetMayProceed(cap(), 40, rpc);
    await resetMayProceed(cap(), 40, rpc);
    assert.equal(calls, 1);
    _resetCaptured();
    assert.equal(await resetMayProceed(cap(), 40, null), true);
  });

  it("keeps nothing for a Match with no board, and still lets the reset go", async () => {
    let calls = 0;
    const rpc = async () => (calls++, true);
    assert.equal(await resetMayProceed(cap({ ...duel, startsAt: 0 }), 40, rpc), true);
    assert.equal(calls, 0);
  });
});

describe("every table upkeep captures before it resets", () => {
  for (const file of ["tables.ts", "holdem.ts", "burst.ts", "vanguard.ts"]) {
    it(`${file}: the capture gate comes before the reset call`, async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const gate = src.indexOf("resetMayProceed(");
      const reset = src.search(/\.resetTable\(/);
      assert.ok(gate > 0 && reset > 0 && gate < reset, `${file} must call resetMayProceed before resetTable (a table's end state is lost at reset)`);
    });
  }
});
