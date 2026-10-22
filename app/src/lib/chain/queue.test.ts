import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { TxFailedError, TxUnconfirmedError, txOutcome, type TxOutcome } from "../../games/block-puzzle/tx";
import { QueueUnconfirmedError, canJoinSeat, queueEntry, type QueueDeps } from "./queue";
import type { ChainMatch } from "./read";

const NOW = 1_800_000_000_000;
const A = "opener-100";
const B = "opener-102";
const NEW = "opener-900";

function match(id: string, over: Partial<ChainMatch> = {}): ChainMatch {
  return {
    id,
    opener: "opener",
    n: 0n,
    game: "block-puzzle",
    running: null,
    openedAt: NOW,
    asset: 0,
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
    fees: { platformBps: 0, studioBps: 0, leaderboardBps: 0 },
    winner: null,
    session: { settled: false, joined: false, result: "draw", scores: [0, 0], seed: 0n, openerDeadline: NOW / 1000 + 3600, deadline: 0 },
    ...over,
  };
}

/** A devnet stand-in: Matches by id, the list read (stale on purpose) and recorded sends. */
function world(opts: { list: string[]; matches: Map<string, ChainMatch>; settle?: TxOutcome }) {
  const calls: string[] = [];
  const deps: QueueDeps = {
    game: "block-puzzle",
    entry: 500,
    now: () => NOW,
    listCandidates: vi.fn(async () => opts.list),
    readMatch: vi.fn(async (id: string) => opts.matches.get(id) ?? null),
    join: vi.fn(async (id: string) => {
      calls.push(`join ${id}`);
    }),
    open: vi.fn(async (id: string) => {
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
    deps.join = vi.fn(async (id: string) => {
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
    deps.join = vi.fn(async (id: string) => {
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
    const C = "opener-104";
    const matches = new Map([
      [A, match(A, { status: "active", opponent: "other" })],
      [B, match(B, { status: "active", opponent: "other" })],
      [C, match(C)],
    ]);
    const { deps, calls } = world({ list: [A, B, C], matches });
    deps.join = vi.fn(async (id: string) => {
      calls.push(`join ${id}`);
      throw new TxFailedError(`sig${id}`, { InstructionError: [0, { Custom: 6001 }] });
    });
    await expect(queueEntry(deps)).resolves.toEqual({ id: NEW, via: "opened" });
    expect(calls).toEqual(["unfinished", `join ${C}`, "unfinished", `open ${NEW}`]);
    expect(deps.join).toHaveBeenCalledTimes(1);
  });

  it("skips Challenges, other entries, own Matches and Matches near their deadline on the fresh read", async () => {
    const ids = ["m-1", "m-2", "m-4", "m-6"];
    const matches = new Map<string, ChainMatch>([
      ["m-1", match("m-1", { challenge: true })],
      ["m-2", match("m-2", { entry: 1000 })],
      ["m-4", match("m-4", { seat: 0 })],
      ["m-6", match("m-6", { deadline: NOW / 1000 + 30 })],
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
    const matches = new Map<string, ChainMatch>();
    const { deps } = world({ list: [], matches, settle: "unknown" });
    deps.open = vi.fn(async (id: string) => {
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

describe("queueEntry for Trading Duel", () => {
  const SOL = "opener-1";
  const ETH = "opener-2";
  const duelMatch = (id: string, asset: number) => match(id, { game: "trading-duel", session: null, asset });

  it("joins only a Match of its own asset (the Match's `meta.asset`) and opens one of that asset otherwise", async () => {
    const matches = new Map([[SOL, duelMatch(SOL, 0)]]);
    const w = world({ list: [SOL], matches });
    const deps: QueueDeps = { ...w.deps, game: "trading-duel", asset: 1, newId: () => "opener-3" };
    const r = await queueEntry(deps);
    expect(r).toEqual({ id: "opener-3", via: "opened" });
    expect(w.calls).not.toContain(`join ${SOL}`);
  });

  it("joins an open Match of the same asset", async () => {
    const matches = new Map([[ETH, duelMatch(ETH, 1)]]);
    const w = world({ list: [ETH], matches });
    const r = await queueEntry({ ...w.deps, game: "trading-duel", asset: 1 });
    expect(r).toEqual({ id: ETH, via: "joined" });
  });
});

// tesoro_core `join` refuses SelfMatch: the same Player, the same funder, or the opener's own Backer.
describe("canJoinSeat (mirrors tesoro_core join)", () => {
  const own = (k: string) => ({ player: k, funder: k });
  it("two Players paying their own entries meet", () => {
    expect(canJoinSeat(own("ana"), own("bo"))).toBe(true);
  });
  it("a Backer cannot play the Player they back", () => {
    expect(canJoinSeat({ player: "ana", funder: "bo" }, own("bo"))).toBe(false);
  });
  it("a backed Player cannot play their own Backer", () => {
    expect(canJoinSeat(own("bo"), { player: "ana", funder: "bo" })).toBe(false);
  });
  it("two Players backed by the same Backer cannot meet", () => {
    expect(canJoinSeat({ player: "ana", funder: "bo" }, { player: "cy", funder: "bo" })).toBe(false);
  });
  it("nobody plays themselves", () => {
    expect(canJoinSeat(own("ana"), own("ana"))).toBe(false);
  });
});

describe("queueEntry skips seats the entrant may not take", () => {
  it("a backed entry never tries to join its own Backer's Match", async () => {
    const matches = new Map([[A, match(A, { sides: [{ player: "bo", funder: "bo", shareBps: 0 }, null] })]]);
    const { deps, calls } = world({ list: [A], matches });
    deps.entrant = { player: "ana", funder: "bo" };
    await expect(queueEntry(deps)).resolves.toEqual({ id: NEW, via: "opened" });
    expect(calls).not.toContain(`join ${A}`);
  });
});
