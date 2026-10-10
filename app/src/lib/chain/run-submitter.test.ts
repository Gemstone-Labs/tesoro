import { describe, expect, it } from "vitest";
import type { Move } from "@/games/block-puzzle/chain";
import { RunSubmitter, type RunIo } from "./run-submitter";

const mv = (piece: number): Move => ({ piece, x: piece, y: 0 }) as Move;

/** A fake Board: `fail` decides per call whether a send throws, and whether its moves landed anyway. */
function board(fail: (call: number) => null | { landed: number; message: string }) {
  const chain: Move[] = [];
  const sent: Move[][] = [];
  let calls = 0;
  const io: RunIo = {
    async play(moves) {
      sent.push(moves);
      const f = fail(calls++);
      if (f) {
        chain.push(...moves.slice(0, f.landed));
        throw new Error(f.message);
      }
      chain.push(...moves);
    },
    async finish() {},
    async movesOnChain() {
      return chain.length;
    },
  };
  return { io, chain, sent };
}

const run = async (io: RunIo, moves: Move[]) => {
  const sub = new RunSubmitter(io, 4, 10_000, 4, 0);
  moves.forEach((m) => sub.push(m));
  const landed = await sub.finish();
  return { sub, landed };
};

describe("RunSubmitter", () => {
  const moves = [1, 2, 3, 4, 5, 6].map(mv);

  it("resends a batch lost to a network error", async () => {
    const b = board((c) => (c === 0 ? { landed: 0, message: "failed to get recent blockhash: TypeError: Failed to fetch" } : null));
    const { sub, landed } = await run(b.io, moves);
    expect(sub.error).toBeNull();
    expect(landed).toBe(6);
    expect(b.chain).toEqual(moves);
  });

  it("sends only the moves that did not land", async () => {
    const b = board((c) => (c === 0 ? { landed: 2, message: "tee tx not confirmed abc" } : null));
    const { landed } = await run(b.io, moves);
    expect(landed).toBe(6);
    expect(b.chain).toEqual(moves);
    expect(b.sent[1]).toEqual(moves.slice(2, 4));
  });

  it("does not resend when the whole batch landed", async () => {
    const b = board((c) => (c === 0 ? { landed: 4, message: "tee tx not confirmed abc" } : null));
    const { landed } = await run(b.io, moves);
    expect(landed).toBe(6);
    expect(b.chain).toEqual(moves);
  });

  it("stops for good when the program refuses", async () => {
    const b = board((c) => (c === 0 ? { landed: 0, message: "failed\nError Message: Illegal move." } : null));
    const { sub, landed } = await run(b.io, moves);
    expect(sub.error?.message).toMatch(/Illegal move/);
    expect(landed).toBe(0);
    expect(b.sent).toHaveLength(1);
  });

  it("gives up without resending when the Board cannot be read", async () => {
    const b = board((c) => (c === 0 ? { landed: 0, message: "Failed to fetch" } : null));
    b.io.movesOnChain = async () => null;
    const { sub } = await run(b.io, moves);
    expect(sub.error).not.toBeNull();
    expect(b.sent).toHaveLength(1);
  });
});
