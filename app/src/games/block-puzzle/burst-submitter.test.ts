import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BurstSubmitter, type BurstIo } from "./burst-submitter";
import type { MoveArg } from "./live-chain";

const mv = (n: number): MoveArg => ({ piece: n, x: n % 8, y: 0 });
const frozenErr = () => new Error('play failed sig: {"InstructionError":[0,{"Custom":6015}]}');
const notFrozenErr = () => new Error('{"InstructionError":[0,{"Custom":6016}]}');
const wrongCount = () => new Error('{"InstructionError":[0,{"Custom":6017}]}');

function io(over: Partial<BurstIo> = {}) {
  const sent: { moves: MoveArg[]; expected: number; hidden: boolean }[] = [];
  const base: BurstIo = {
    send: async (moves, expected, hidden) => void sent.push({ moves, expected, hidden }),
    movesOnChain: async () => sent.reduce((n, s) => n + s.moves.length, 0),
    frozen: () => false,
  };
  return { io: { ...base, ...over }, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BurstSubmitter", () => {
  it("flushes what is pending half a second after the last move", async () => {
    const { io: i, sent } = io();
    const s = new BurstSubmitter(i);
    s.push(mv(0));
    s.push(mv(1));
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].moves).toHaveLength(2);
  });

  it("sends a full batch of 8 at once and carries the on-chain count as the nonce", async () => {
    const { io: i, sent } = io();
    const s = new BurstSubmitter(i);
    for (let n = 0; n < 8; n++) s.push(mv(n));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ expected: 0, hidden: false });
    expect(sent[0].moves).toHaveLength(8);
    s.push(mv(8));
    await s.finish();
    expect(sent[1].expected).toBe(8);
    expect(s.landed).toBe(9);
  });

  it("never sends more than 8 moves in one transaction", async () => {
    const { io: i, sent } = io();
    const s = new BurstSubmitter(i, { batch: 40 });
    for (let n = 0; n < 20; n++) s.push(mv(n));
    await s.finish();
    expect(sent.every((x) => x.moves.length <= 8)).toBe(true);
    expect(sent.map((x) => x.moves.length)).toEqual([8, 8, 4]);
    expect(sent.map((x) => x.expected)).toEqual([0, 8, 16]);
  });

  it("flushes everything left at time-up", async () => {
    const { io: i, sent } = io();
    const s = new BurstSubmitter(i);
    s.push(mv(0));
    expect(await s.finish()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a resumed run starts counting from the moves already on chain", async () => {
    const { io: i, sent } = io();
    const s = new BurstSubmitter(i, { startCount: 12 });
    s.push(mv(0));
    await s.finish();
    expect(sent[0].expected).toBe(12);
    expect(s.landed).toBe(13);
  });

  it("sends the hidden play once the scores are frozen", async () => {
    let frozen = false;
    const { io: i, sent } = io({ frozen: () => frozen });
    const s = new BurstSubmitter(i);
    s.push(mv(0));
    await s.finish();
    frozen = true;
    s.push(mv(1));
    await s.finish();
    expect(sent.map((x) => x.hidden)).toEqual([false, true]);
  });

  it("a play that lands after the freeze fails Frozen and is resent hidden", async () => {
    const calls: boolean[] = [];
    const { io: i } = io({
      send: async (_m, _e, hidden) => {
        calls.push(hidden);
        if (!hidden) throw frozenErr();
      },
    });
    const s = new BurstSubmitter(i);
    s.push(mv(0));
    await s.finish();
    expect(calls).toEqual([false, true]);
    expect(s.error).toBeNull();
    expect(s.landed).toBe(1);
  });

  it("a hidden play before the freeze fails NotFrozen and is resent public", async () => {
    const calls: boolean[] = [];
    const { io: i } = io({
      frozen: () => true,
      send: async (_m, _e, hidden) => {
        calls.push(hidden);
        if (hidden) throw notFrozenErr();
      },
    });
    const s = new BurstSubmitter(i);
    s.push(mv(0));
    await s.finish();
    expect(calls).toEqual([true, false]);
  });

  it("a send whose answer was lost is not applied twice: the Board says it landed", async () => {
    let landed = 0;
    const { io: i } = io({
      send: async (moves) => {
        landed += moves.length;
        throw new Error("fetch failed");
      },
      movesOnChain: async () => landed,
    });
    const s = new BurstSubmitter(i, { backoffMs: 1 });
    s.push(mv(0));
    s.push(mv(1));
    await vi.advanceTimersByTimeAsync(600);
    await s.finish();
    expect(landed).toBe(2);
    expect(s.landed).toBe(2);
    expect(s.error).toBeNull();
  });

  it("WrongCount after a partial landing resends only the tail", async () => {
    const sent: MoveArg[][] = [];
    let onChain = 0;
    const { io: i } = io({
      send: async (moves, expected) => {
        if (expected !== onChain) throw wrongCount();
        if (sent.length === 0) {
          onChain += 2;
          sent.push(moves.slice(0, 2));
          throw wrongCount();
        }
        onChain += moves.length;
        sent.push(moves);
      },
      movesOnChain: async () => onChain,
    });
    const s = new BurstSubmitter(i, { backoffMs: 1 });
    for (let n = 0; n < 5; n++) s.push(mv(n));
    await s.finish();
    expect(sent.map((x) => x.length)).toEqual([2, 3]);
    expect(s.landed).toBe(5);
  });

  it("does not resend blind when the Board cannot be read", async () => {
    const send = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const s = new BurstSubmitter({ send, movesOnChain: async () => null, frozen: () => false }, { backoffMs: 1 });
    s.push(mv(0));
    const done = s.finish();
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.error).toBeTruthy();
  });

  it("a refused move is final: nothing after it is sent", async () => {
    const send = vi.fn(async () => {
      throw new Error('{"InstructionError":[0,{"Custom":6019}]}');
    });
    const s = new BurstSubmitter({ send, movesOnChain: async () => 0, frozen: () => false });
    s.push(mv(0));
    await s.finish();
    s.push(mv(1));
    await s.finish();
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.error?.message).toMatch(/6019/);
  });

  it("a batch refused for pace waits and goes again", async () => {
    let n = 0;
    const send = vi.fn(async () => {
      if (n++ === 0) throw new Error('{"InstructionError":[0,{"Custom":6020}]}');
    });
    const s = new BurstSubmitter({ send, movesOnChain: async () => 0, frozen: () => false }, { backoffMs: 5 });
    s.push(mv(0));
    const done = s.finish();
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(send).toHaveBeenCalledTimes(2);
    expect(s.error).toBeNull();
  });
});
