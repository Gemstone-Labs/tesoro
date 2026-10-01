import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { TxFailedError, TxUnconfirmedError, txOutcome, type TxOutcome } from "../../games/block-puzzle/tx";
import { QueueUnconfirmedError, queueEntry, type QueueDeps } from "./queue";
import type { ChainMatch } from "./read";

const NOW = 1_800_000_000_000;
const A = 100n;
const B = 102n;
const NEW = 900n;

function match(id: bigint, over: Partial<ChainMatch> = {}): ChainMatch {
  return {
    id,
    game: "block-puzzle",
    address: PublicKey.default,
    status: "open",
    entry: 500,
    seat: null,
    opponent: null,
    deadline: NOW / 1000 + 3600,
    challenge: false,
    sides: [{ player: "opener", funder: "opener", shareBps: 0 }, null],
    backerSeat: null,
    backing: null,
    fees: { platformBps: 0, studioBps: 0 },
    winner: null,
    session: { settled: false, joined: false, result: "draw", scores: [0, 0], seed: 0n, openerDeadline: NOW / 1000 + 3600, deadline: 0 },
    ...over,
  };
}

/** A devnet stand-in: Matches by id, the list read (stale on purpose) and recorded sends. */
function world(opts: { list: bigint[]; matches: Map<bigint, ChainMatch>; settle?: TxOutcome }) {
  const calls: string[] = [];
  const deps: QueueDeps = {
    game: "block-puzzle",
    entry: 500,
    now: () => NOW,
    listCandidates: vi.fn(async () => opts.list),
    readMatch: vi.fn(async (id: bigint) => opts.matches.get(id) ?? null),
    join: vi.fn(async (id: bigint) => {
      calls.push(`join ${id}`);
    }),
    open: vi.fn(async (id: bigint) => {
      calls.push(`open ${id}`);
    }),
    settle: vi.fn(async () => opts.settle ?? "unknown"),
    unfinished: vi.fn(async () => {
      calls.push("unfinished");
      return [];
    }),
    newId: () => NEW,
  };
  return { deps, calls };
}

describe("queueEntry (OC-04)", () => {
  it("a join that timed out but landed continues in that Match and never opens a second", async () => {
    const matches = new Map([[A, match(A)]]);
    const { deps, calls } = world({ list: [A], matches, settle: "landed" });
    deps.join = vi.fn(async () => {
      // The join lands after the client gave up waiting.
      matches.set(A, match(A, { status: "active", seat: 1 }));
      throw new TxUnconfirmedError("sigA", 1000);
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: A, via: "joined" });
    expect(deps.open).not.toHaveBeenCalled();
    expect(calls).not.toContain(`open ${NEW}`);
  });

  it("a timed-out join with no signature status yet is settled by the Match account", async () => {
    const matches = new Map([
      [A, match(A)],
      [B, match(B)],
    ]);
    const { deps } = world({ list: [A, B], matches, settle: "unknown" });
    deps.join = vi.fn(async () => {
      matches.set(A, match(A, { status: "active", seat: 1 }));
      throw new TxUnconfirmedError("sigA", 1000);
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: A, via: "joined" });
    expect(deps.join).toHaveBeenCalledTimes(1);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("a definite failure moves on to the next candidate", async () => {
    const matches = new Map([
      [A, match(A)],
      [B, match(B)],
    ]);
    const { deps, calls } = world({ list: [A, B], matches });
    deps.join = vi.fn(async (id: bigint) => {
      calls.push(`join ${id}`);
      if (id === A) throw new TxFailedError("sigA", { InstructionError: [0, { Custom: 6001 }] });
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: B, via: "joined" });
    expect(calls).toEqual(["unfinished", `join ${A}`, `join ${B}`]);
  });

  it("an expired join whose Match shows someone else seated counts as failed", async () => {
    const matches = new Map([
      [A, match(A)],
      [B, match(B)],
    ]);
    const { deps, calls } = world({ list: [A, B], matches, settle: "expired" });
    deps.join = vi.fn(async (id: bigint) => {
      calls.push(`join ${id}`);
      if (id === A) {
        matches.set(A, match(A, { status: "active", opponent: "other" }));
        throw new TxUnconfirmedError("sigA", 1000);
      }
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: B, via: "joined" });
    expect(calls).toEqual(["unfinished", `join ${A}`, `join ${B}`]);
  });

  it("an unconfirmed join that cannot be settled stops: no next candidate, no new Match", async () => {
    const matches = new Map([
      [A, match(A)],
      [B, match(B)],
    ]);
    const { deps } = world({ list: [A, B], matches, settle: "unknown" });
    deps.join = vi.fn(async () => {
      throw new TxUnconfirmedError("sigA", 1000);
    });
    await expect(queueEntry(deps)).rejects.toBeInstanceOf(QueueUnconfirmedError);
    expect(deps.join).toHaveBeenCalledTimes(1);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("an unclassified error is rethrown and never opens a Match", async () => {
    const matches = new Map([[A, match(A)]]);
    const { deps } = world({ list: [A], matches });
    deps.join = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    await expect(queueEntry(deps)).rejects.toThrow("User rejected");
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("stale candidates are re-read, tried ids are excluded, and a new Match opens only after the Active check", async () => {
    // The list keeps serving A and B (stale), but fresh reads show both already taken, and C fails.
    const C = 104n;
    const matches = new Map([
      [A, match(A, { status: "active", opponent: "other" })],
      [B, match(B, { status: "active", opponent: "other" })],
      [C, match(C)],
    ]);
    const { deps, calls } = world({ list: [A, B, C], matches });
    deps.join = vi.fn(async (id: bigint) => {
      calls.push(`join ${id}`);
      throw new TxFailedError(`sig${id}`, { InstructionError: [0, { Custom: 6001 }] });
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: NEW, via: "opened" });
    expect(calls).toEqual(["unfinished", `join ${C}`, "unfinished", `open ${NEW}`]);
    expect(deps.join).toHaveBeenCalledTimes(1);
  });

  it("skips Challenges, other entries, own Matches and Matches near their deadline on the fresh read", async () => {
    const ids = [1n, 2n, 4n, 6n];
    const matches = new Map<bigint, ChainMatch>([
      [1n, match(1n, { challenge: true })],
      [2n, match(2n, { entry: 1000 })],
      [4n, match(4n, { seat: 0 })],
      [6n, match(6n, { deadline: NOW / 1000 + 30 })],
    ]);
    const { deps, calls } = world({ list: ids, matches });
    await expect(queueEntry(deps)).resolves.toEqual({ id: NEW, via: "opened" });
    expect(calls).toEqual(["unfinished", "unfinished", `open ${NEW}`]);
  });

  it("shows the existing Match instead of opening another when the Player still has one to play", async () => {
    const { deps, calls } = world({ list: [], matches: new Map() });
    let checks = 0;
    deps.unfinished = vi.fn(async () => (++checks === 2 ? [match(A, { status: "active", seat: 1 })] : []));
    await expect(queueEntry(deps)).resolves.toEqual({ id: A, via: "existing" });
    expect(deps.open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("an open that timed out but landed returns the opened Match", async () => {
    const matches = new Map<bigint, ChainMatch>();
    const { deps } = world({ list: [], matches, settle: "unknown" });
    deps.open = vi.fn(async (id: bigint) => {
      matches.set(id, match(id, { seat: 0 }));
      throw new TxUnconfirmedError("sigOpen", 1000);
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: NEW, via: "opened" });
  });

  it("a backed entry stops when its Offer can no longer be used", async () => {
    const matches = new Map([
      [A, match(A)],
      [B, match(B)],
    ]);
    const { deps } = world({ list: [A, B], matches });
    deps.join = vi.fn(async () => {
      throw new TxFailedError("sigA", { InstructionError: [0, { Custom: 6001 }] });
    });
    deps.canRetry = vi.fn(async () => false);
    await expect(queueEntry(deps)).rejects.toBeInstanceOf(TxFailedError);
    expect(deps.join).toHaveBeenCalledTimes(1);
    expect(deps.open).not.toHaveBeenCalled();
  });
});

describe("txOutcome", () => {
  const conn = (statuses: (null | { confirmationStatus: string; err: unknown })[], heights: number[]) => {
    let s = 0;
    let h = 0;
    return {
      getSignatureStatuses: vi.fn(async () => ({ context: { slot: 0 }, value: [statuses[Math.min(s++, statuses.length - 1)]] })),
      getBlockHeight: vi.fn(async () => heights[Math.min(h++, heights.length - 1)]),
    } as any;
  };

  it("reports a late confirmation as landed", async () => {
    const c = conn([null, null, { confirmationStatus: "confirmed", err: null }], [900]);
    await expect(txOutcome(c, "sig", 1000, 1000, 1)).resolves.toBe("landed");
  });

  it("reports a landed error as failed", async () => {
    const c = conn([{ confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }], [900]);
    await expect(txOutcome(c, "sig", 1000, 1000, 1)).resolves.toBe("failed");
  });

  it("reports expired once the blockhash is past its last valid height and the signature is unseen", async () => {
    const c = conn([null], [900, 1001]);
    await expect(txOutcome(c, "sig", 1000, 1000, 1)).resolves.toBe("expired");
  });

  it("keeps waiting on a processed transaction past its last valid height", async () => {
    const c = conn([null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }], [1001]);
    await expect(txOutcome(c, "sig", 1000, 1000, 1)).resolves.toBe("landed");
  });

  it("is unknown when RPC never answers", async () => {
    const c = { getSignatureStatuses: vi.fn(async () => Promise.reject(new Error("429"))), getBlockHeight: vi.fn() } as any;
    await expect(txOutcome(c, "sig", 1000, 30, 1)).resolves.toBe("unknown");
  });
});
