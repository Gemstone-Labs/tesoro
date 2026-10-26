import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BurstSubmitter, type BurstIo, type SubmitterOptions } from "./burst-submitter";
import type { MoveArg } from "./live-chain";

const mv = (n: number): MoveArg => ({ piece: n, x: n % 8, y: 0 });
const frozenErr = () => new Error('play failed sig: {"InstructionError":[0,{"Custom":6015}]}');
const wrongCount = () => new Error('{"InstructionError":[0,{"Custom":6017}]}');

function io(over: Partial<BurstIo> = {}) {
  const sent: { moves: MoveArg[]; expected: number; hidden: boolean; beat: number; at: number }[] = [];
  const base: BurstIo = {
    send: async (moves, expected, hidden, beat) => void sent.push({ moves, expected, hidden, beat, at: Date.now() }),
    movesOnChain: async () => sent.reduce((n, s) => n + s.moves.length, 0),
    slot: () => 0,
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
    const s = new BurstSubmitter({ send, movesOnChain: async () => null, slot: () => 0 }, { backoffMs: 1 });
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
    const s = new BurstSubmitter({ send, movesOnChain: async () => 0, slot: () => 0 });
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
    const s = new BurstSubmitter({ send, movesOnChain: async () => 0, slot: () => 0 }, { backoffMs: 5 });
    s.push(mv(0));
    const done = s.finish();
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(send).toHaveBeenCalledTimes(2);
    expect(s.error).toBeNull();
  });
});

// -- the hidden beat (ticket 43) ----------------------------------------------------------------------

/** A rollup whose slot is the fake clock: 100 slots a second from `t0`, `slot0` at `t0`. */
const HIDDEN_FROM = 8000;
function hidden(over: Partial<BurstIo> = {}, opts: SubmitterOptions = {}) {
  const t0 = Date.now();
  const clockSlot = () => HIDDEN_FROM - 200 + Math.floor((Date.now() - t0) / 10);
  const { io: i, sent } = io({ slot: clockSlot, ...over });
  const s = new BurstSubmitter(i, { freezeSlot: HIDDEN_FROM, ...opts });
  return { s, sent, slot: clockSlot, t0 };
}

describe("BurstSubmitter, hidden beats", () => {
  it("sends one beat per 60 slots from 30 slots after the freeze, 21 in all, moved or not", async () => {
    const { s, sent, t0 } = hidden();
    await vi.advanceTimersByTimeAsync(2000 + 300 + 21 * 600);
    expect(sent.every((x) => x.hidden)).toBe(true);
    expect(sent).toHaveLength(21);
    expect(sent.map((x) => x.beat)).toEqual(Array.from({ length: 21 }, (_, k) => k));
    // The freeze is 2 s after t0; the first beat 0.3 s later, then every 0.6 s.
    expect(sent.map((x) => x.at - t0)).toEqual(Array.from({ length: 21 }, (_, k) => 2300 + k * 600));
    expect(sent.every((x) => x.moves.length === 0)).toBe(true);
    expect(s.beatsSent).toBe(21);
  });

  it("the rhythm is the same whether the Player moves or not", async () => {
    const idle = hidden();
    await vi.advanceTimersByTimeAsync(2000 + 300 + 21 * 600);
    const idleTimes = idle.sent.map((x) => x.at - idle.t0);
    idle.s.stop();
    const busy = hidden();
    for (let n = 0; n < 40; n++) {
      busy.s.push(mv(n));
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(2000 + 300 + 21 * 600);
    expect(busy.sent.filter((x) => x.hidden).map((x) => x.at - busy.t0)).toEqual(idleTimes);
    expect(busy.sent.filter((x) => x.hidden).length).toBe(21);
  });

  it("moves made during the hidden window wait for the next beat and never trigger a send of their own", async () => {
    const { s, sent, t0 } = hidden();
    await vi.advanceTimersByTimeAsync(2000 + 300 + 100);
    expect(sent).toHaveLength(1);
    s.push(mv(0));
    s.push(mv(1));
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ expected: 0, hidden: true });
    expect(sent[1].moves).toHaveLength(2);
    expect(sent[1].at - t0).toBe(2900);
    expect(s.landed).toBe(2);
  });

  it("a full queue goes 8 a beat, in order, with the count as the nonce", async () => {
    const { s, sent } = hidden();
    for (let n = 0; n < 20; n++) s.push(mv(n));
    await vi.advanceTimersByTimeAsync(2300 + 5 * 600);
    const real = sent.filter((x) => x.moves.length);
    expect(real.map((x) => [x.expected, x.moves.length])).toEqual([[0, 8], [8, 8], [16, 4]]);
    expect(s.landed).toBe(20);
  });

  it("a beat that fails is not retried: the moves ride on the next beat, which the program skips if the first had landed", async () => {
    let calls = 0;
    const { s, sent } = hidden({
      send: async (moves, expected, h, beat) => {
        sent2.push({ moves, expected, beat });
        if (calls++ === 0) throw new Error("fetch failed");
      },
    });
    const sent2: { moves: MoveArg[]; expected: number; beat: number }[] = [];
    void sent;
    await vi.advanceTimersByTimeAsync(2000);
    s.push(mv(0));
    await vi.advanceTimersByTimeAsync(300 + 100);
    expect(sent2).toHaveLength(1);
    expect(s.landed).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(sent2).toHaveLength(2);
    expect(sent2[1]).toMatchObject({ expected: 0, beat: 1 });
    expect(sent2[1].moves).toHaveLength(1);
    expect(s.landed).toBe(1);
    expect(s.error).toBeNull();
  });

  it("a beat still in flight does not delay the next one", async () => {
    let release: () => void = () => {};
    let n = 0;
    const times: number[] = [];
    const t0 = Date.now();
    const { s } = hidden({
      send: () => {
        times.push(Date.now() - t0);
        return n++ === 0 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
      },
    });
    await vi.advanceTimersByTimeAsync(2300 + 1300);
    expect(times).toEqual([2300, 2900, 3500]);
    release();
    s.stop();
  });

  it("a Player who did not play before the freeze still beats, and a public play never goes within 30 slots of it", async () => {
    const { s, sent } = hidden();
    await vi.advanceTimersByTimeAsync(1700); // 20 slots before the freeze
    s.push(mv(0));
    await vi.advanceTimersByTimeAsync(600);
    expect(sent.filter((x) => !x.hidden)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter((x) => x.hidden)).toHaveLength(1);
    expect(sent[0].moves).toHaveLength(1);
  });

  it("a public play that meets the freeze is not resent as a hidden one: the beat carries it", async () => {
    const { s, sent } = hidden({
      send: async (m, e, h, b) => {
        sent3.push({ hidden: h, n: m.length, expected: e, beat: b });
        if (!h) throw frozenErr();
      },
    });
    const sent3: { hidden: boolean; n: number; expected: number; beat: number }[] = [];
    void sent;
    await vi.advanceTimersByTimeAsync(1100);
    s.push(mv(0));
    await vi.advanceTimersByTimeAsync(500 + 700 + 100);
    expect(sent3.map((x) => x.hidden)).toEqual([false, true]);
    expect(sent3[1]).toMatchObject({ n: 1, expected: 0, beat: 0 });
    expect(s.landed).toBe(1);
  });

  it("an empty beat refused at the very end is not an error, a refused move is", async () => {
    const { s } = hidden({
      send: async (moves) => {
        throw new Error(moves.length ? '{"InstructionError":[0,{"Custom":6019}]}' : '{"InstructionError":[0,{"Custom":6014}]}');
      },
    });
    await vi.advanceTimersByTimeAsync(2300 + 100);
    expect(s.error).toBeNull();
    s.push(mv(0));
    await vi.advanceTimersByTimeAsync(600);
    expect(s.error?.message).toMatch(/6019/);
  });

  it("joins the grid where it is after a reload, and stops after the last beat", async () => {
    const t0 = Date.now();
    const slot = () => HIDDEN_FROM + 130 + Math.floor((Date.now() - t0) / 10);
    const { io: i, sent } = io({ slot });
    const s = new BurstSubmitter(i, { freezeSlot: HIDDEN_FROM, startCount: 5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent[0].beat).toBe(2); // slot 130 is past beats 0 (30) and 1 (90); beat 2 is due at 150
    expect(sent[0].at - t0).toBe(200);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.map((x) => x.beat).at(-1)).toBe(20);
    expect(s.beatsSent).toBe(19);
  });

  it("finish() in the hidden window sends nothing of its own", async () => {
    const { s, sent } = hidden();
    await vi.advanceTimersByTimeAsync(2300 + 100);
    s.push(mv(0));
    const done = s.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBe(1);
    expect(sent).toHaveLength(21);
  });

  it("keeps below the pace the program allows", async () => {
    const { s, sent } = hidden({ paceLimit: (slot) => 3 + Math.floor((slot - (HIDDEN_FROM - 200)) / 100) });
    for (let n = 0; n < 12; n++) s.push(mv(n));
    await vi.advanceTimersByTimeAsync(2300 + 100);
    expect(sent[0].moves.length).toBeLessThanOrEqual(8);
    expect(sent[0].expected + sent[0].moves.length).toBeLessThanOrEqual(3 + 22);
  });
});

describe("BurstSubmitter, review fixes", () => {
  it("a public play refused for pace does not go again once the guard before the freeze has passed", async () => {
    let slotNow = HIDDEN_FROM - 60;
    const send = vi.fn(async (_m: MoveArg[], _e: number, hiddenBeat: boolean) => {
      if (!hiddenBeat) {
        slotNow = HIDDEN_FROM - 10; // the retry would reach the program after the guard
        throw new Error('{"InstructionError":[0,{"Custom":6020}]}');
      }
    });
    const s = new BurstSubmitter({ send, movesOnChain: async () => 0, slot: () => slotNow }, { freezeSlot: HIDDEN_FROM, backoffMs: 5 });
    s.push(mv(0));
    await vi.advanceTimersByTimeAsync(600);
    expect(send.mock.calls.filter((c) => c[2] === false)).toHaveLength(1);
  });

  it("waits for the slot clock instead of firing every beat at once", async () => {
    let ready = false;
    const sent: number[] = [];
    const clockSlot = () => (ready ? HIDDEN_FROM - 200 + Math.floor((Date.now() - t0) / 10) : 0);
    const t0 = Date.now();
    const s = new BurstSubmitter({ send: async (_m, _e, _h, beat) => void sent.push(beat), movesOnChain: async () => 0, slot: clockSlot }, { freezeSlot: HIDDEN_FROM });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(0);
    ready = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(21);
    s.stop();
  });
});

