import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { TxFailedError, TxUnconfirmedError } from "../../games/block-puzzle/tx";
import { QueueUnconfirmedError, canMove, isOlder, mergeQueue, type MergeDeps } from "./queue";
import type { ChainMatch } from "./read";

const NOW = 1_800_000_000_000;
const OLD = "alice-0";
const YOUNG = "ben-0";
const NEW = "ben-1";
const failed = () => new TxFailedError("sig", { InstructionError: [0, "Custom"] });

function match(id: string, over: Partial<ChainMatch> = {}): ChainMatch {
  const player = id.split("-")[0];
  return {
    id,
    opener: player,
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
    sides: [{ player, funder: player, shareBps: 0 }, null],
    backerSeat: null,
    backing: null,
    fees: { platformBps: 0, studioBps: 0, leaderboardBps: 0 },
    winner: null,
    session: null,
    ...over,
  };
}

/** The chain as `me` sees it: each Match with its own seat for `me`, the list read, and recorded sends. */
function world(me: string, matches: Map<string, ChainMatch>, list?: string[]) {
  const calls: string[] = [];
  const view = (id: string) => {
    const m = matches.get(id);
    return m ? { ...m, seat: m.sides[0].player === me ? (0 as const) : m.sides[1]?.player === me ? (1 as const) : null } : null;
  };
  const deps: MergeDeps = {
    game: "block-puzzle",
    entry: 500,
    now: () => NOW,
    entrant: { player: me, funder: me },
    listCandidates: vi.fn(async () => list ?? [...matches.keys()].filter((id) => matches.get(id)!.status === "open" && matches.get(id)!.sides[0].player !== me)),
    readMatch: vi.fn(async (id: string) => view(id)),
    join: vi.fn(async (id: string) => {
      calls.push(`join ${id}`);
      const m = matches.get(id)!;
      matches.set(id, { ...m, status: "active", opponent: me, sides: [m.sides[0], { player: me, funder: me, shareBps: 0 }] });
    }),
    open: vi.fn(async (id: string) => {
      calls.push(`open ${id}`);
      matches.set(id, match(id, { openedAt: NOW + 5000 }));
    }),
    refund: vi.fn(async (id: string) => {
      calls.push(`refund ${id}`);
      // The refund is two-phase: the Match is Refunding (not joinable, still unfinished) until the keeper's steps close it.
      matches.set(id, { ...matches.get(id)!, status: "active", running: "refunding" });
    }),
    pause: vi.fn(async () => {
      for (const [id, m] of matches) if (m.running === "refunding") matches.set(id, { ...m, status: "refunded", running: null });
    }),
    settle: vi.fn(async () => "unknown" as const),
    unfinished: vi.fn(async () => [...matches.keys()].map((id) => view(id)!).filter((m) => m.seat !== null && (m.status === "open" || m.status === "active"))),
    newId: () => NEW,
  };
  return { deps, calls, view };
}

describe("two Players opened a Match within a moment of each other", () => {
  const both = () =>
    new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);

  it("the younger refunds its entry and joins the older Match", async () => {
    const matches = both();
    const ben = world("ben", matches);
    const r = await mergeQueue(ben.deps, ben.view(YOUNG)!);
    expect(r).toEqual({ moved: true, entered: { id: OLD, via: "joined" } });
    expect(ben.calls).toEqual([`refund ${YOUNG}`, `join ${OLD}`]);
    expect(matches.get(YOUNG)!.running).toBe("refunding");
    expect(matches.get(OLD)!.opponent).toBe("ben");
  });

  it("the older Match never moves", async () => {
    const matches = both();
    const alice = world("alice", matches);
    expect(await mergeQueue(alice.deps, alice.view(OLD)!)).toEqual({ moved: false });
    expect(alice.calls).toEqual([]);
  });

  it("both pages checking at the same instant: exactly one Match is left, with both Players in it", async () => {
    const matches = both();
    const alice = world("alice", matches);
    const ben = world("ben", matches);
    const [a, b] = await Promise.all([mergeQueue(alice.deps, alice.view(OLD)!), mergeQueue(ben.deps, ben.view(YOUNG)!)]);
    expect(a.moved).toBe(false);
    expect(b.moved).toBe(true);
    const live = [...matches.values()].filter((m) => (m.status === "open" || m.status === "active") && m.running !== "refunding");
    expect(live.map((m) => m.id)).toEqual([OLD]);
    expect([live[0].sides[0].player, live[0].sides[1]?.player]).toEqual(["alice", "ben"]);
  });

  it("an equal opening time falls back to the Match key, so still only one moves", async () => {
    const matches = new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW })],
    ]);
    const alice = world("alice", matches);
    const ben = world("ben", matches);
    const [a, b] = await Promise.all([mergeQueue(alice.deps, alice.view(OLD)!), mergeQueue(ben.deps, ben.view(YOUNG)!)]);
    expect([a.moved, b.moved]).toEqual([false, true]);
    expect(isOlder(match(OLD), match(YOUNG))).toBe(true);
    expect(isOlder(match(YOUNG), match(OLD))).toBe(false);
  });

  it("three waiting Matches: the youngest moves into the oldest, the middle one is not touched", async () => {
    const matches = new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      ["cara-0", match("cara-0", { openedAt: NOW + 4000 })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);
    const ben = world("ben", matches);
    expect(await mergeQueue(ben.deps, ben.view(YOUNG)!)).toMatchObject({ moved: true, entered: { id: OLD } });
  });
});

describe("a move that goes wrong", () => {
  const both = () =>
    new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);

  it("the older seat is taken by a third Player after the refund: the Player joins another Match or opens a new one, never ends with nothing", async () => {
    const matches = both();
    const ben = world("ben", matches);
    ben.deps.join = vi.fn(async (id: string) => {
      matches.set(id, { ...matches.get(id)!, status: "active", opponent: "cara" });
      throw failed();
    });
    const r = await mergeQueue(ben.deps, ben.view(YOUNG)!);
    expect(r).toEqual({ moved: true, entered: { id: NEW, via: "opened" } });
    expect(matches.get(NEW)!.status).toBe("open");
  });

  it("the refund fails because someone just joined: the Player stays in that Match and nothing else is entered", async () => {
    const matches = both();
    const ben = world("ben", matches);
    ben.deps.refund = vi.fn(async (id: string) => {
      matches.set(id, { ...matches.get(id)!, status: "active", opponent: "dan" });
      throw failed();
    });
    expect(await mergeQueue(ben.deps, ben.view(YOUNG)!)).toEqual({ moved: false });
    expect(ben.deps.join).not.toHaveBeenCalled();
    expect(ben.deps.open).not.toHaveBeenCalled();
  });

  it("a refund that fails outright leaves the Player waiting where they are", async () => {
    const matches = both();
    const ben = world("ben", matches);
    ben.deps.refund = vi.fn(async () => {
      throw failed();
    });
    expect(await mergeQueue(ben.deps, ben.view(YOUNG)!)).toEqual({ moved: false });
    expect(matches.get(YOUNG)!.status).toBe("open");
  });

  it("a refund that timed out and cannot be settled throws and enters nothing", async () => {
    const matches = both();
    const ben = world("ben", matches);
    ben.deps.refund = vi.fn(async () => {
      throw new TxUnconfirmedError("sig", 1000);
    });
    await expect(mergeQueue(ben.deps, ben.view(YOUNG)!)).rejects.toBeInstanceOf(QueueUnconfirmedError);
    expect(ben.deps.join).not.toHaveBeenCalled();
    expect(ben.deps.open).not.toHaveBeenCalled();
  });

  it("a refund that timed out but landed goes on to join", async () => {
    const matches = both();
    const ben = world("ben", matches);
    ben.deps.settle = vi.fn(async () => "landed" as const);
    ben.deps.refund = vi.fn(async (id: string) => {
      matches.set(id, { ...matches.get(id)!, status: "active", running: "refunding" });
      throw new TxUnconfirmedError("sig", 1000);
    });
    expect(await mergeQueue(ben.deps, ben.view(YOUNG)!)).toMatchObject({ moved: true, entered: { id: OLD, via: "joined" } });
  });

  it("a join that cannot be settled after the refund throws, and the entry is the Player's again (nothing opened)", async () => {
    const matches = both();
    const ben = world("ben", matches);
    ben.deps.join = vi.fn(async () => {
      throw new TxUnconfirmedError("sig", 1000);
    });
    await expect(mergeQueue(ben.deps, ben.view(YOUNG)!)).rejects.toBeInstanceOf(QueueUnconfirmedError);
    expect(matches.get(YOUNG)!.running).toBe("refunding");
    expect(ben.deps.open).not.toHaveBeenCalled();
  });
});

describe("the entry is still on its way back", () => {
  it("the join does not wait for the refund and the refunding Match is not taken for the Player's seat", async () => {
    const matches = new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);
    const ben = world("ben", matches);
    const r = await mergeQueue(ben.deps, ben.view(YOUNG)!);
    expect(r).toMatchObject({ moved: true, entered: { id: OLD, via: "joined" } });
    expect(ben.deps.pause).not.toHaveBeenCalled();
  });

  it("too few free Gemas to join before the entry is back: waits for the refund to close, then joins", async () => {
    const matches = new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);
    const ben = world("ben", matches);
    const join = ben.deps.join;
    ben.deps.join = vi.fn(async (id: string) => {
      if (matches.get(YOUNG)!.running === "refunding") throw failed();
      return join(id);
    });
    ben.deps.open = vi.fn(async () => {
      throw failed();
    });
    const r = await mergeQueue(ben.deps, ben.view(YOUNG)!);
    expect(r).toMatchObject({ moved: true, entered: { id: OLD, via: "joined" } });
    expect(matches.get(YOUNG)!.status).toBe("refunded");
  });

  it("a just-opened Match the server will not sponsor a join into yet: the same join is retried until it works", async () => {
    const matches = new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);
    const ben = world("ben", matches);
    const join = ben.deps.join;
    let tries = 0;
    ben.deps.join = vi.fn(async (id: string) => {
      if (++tries < 3) throw new Error("Free transactions are unavailable.");
      return join(id);
    });
    const r = await mergeQueue(ben.deps, ben.view(YOUNG)!);
    expect(r).toMatchObject({ moved: true, entered: { id: OLD, via: "joined" } });
    expect(tries).toBe(3);
  });

  it("the refund never finishes: throws so the screen can say so, and nothing else is entered", async () => {
    const matches = new Map([
      [OLD, match(OLD, { openedAt: NOW })],
      [YOUNG, match(YOUNG, { openedAt: NOW + 11_000 })],
    ]);
    const ben = world("ben", matches);
    ben.deps.pause = vi.fn(async () => undefined);
    ben.deps.join = vi.fn(async () => {
      throw failed();
    });
    ben.deps.open = vi.fn(async () => {
      throw failed();
    });
    await expect(mergeQueue(ben.deps, ben.view(YOUNG)!)).rejects.toBeInstanceOf(TxFailedError);
  });
});

describe("what never moves", () => {
  const older = new Map([[OLD, match(OLD, { openedAt: NOW - 5000 })]]);
  const run = async (mine: ChainMatch, extra = older) => {
    const matches = new Map([...extra, [mine.id, mine]]);
    const ben = world("ben", matches);
    const r = await mergeQueue(ben.deps, ben.view(mine.id)!);
    return { r, ben };
  };

  it("a Challenge", async () => {
    const { r, ben } = await run(match(YOUNG, { challenge: true }));
    expect(r).toEqual({ moved: false });
    expect(ben.calls).toEqual([]);
  });

  it("a Backed entry", async () => {
    const { r } = await run(match(YOUNG, { backing: { seat: 0, player: "ben", funder: "bob", shareBps: 5000 } }));
    expect(r).toEqual({ moved: false });
  });

  it("a Match that already has an opponent", async () => {
    const { r } = await run(match(YOUNG, { status: "active", opponent: "dan" }));
    expect(r).toEqual({ moved: false });
  });

  it("when no older Match exists, or the older one is not joinable (Challenge, funded by the Player, other entry, near its deadline)", async () => {
    for (const other of [
      match(OLD, { openedAt: NOW - 5000, challenge: true }),
      match(OLD, { openedAt: NOW - 5000, sides: [{ player: "alice", funder: "ben", shareBps: 0 }, null] }),
      match(OLD, { openedAt: NOW - 5000, entry: 100 }),
      match(OLD, { openedAt: NOW - 5000, deadline: NOW / 1000 + 30 }),
      match(OLD, { openedAt: NOW + 1000 }),
    ]) {
      const { r, ben } = await run(match(YOUNG, { openedAt: NOW }), new Map([[OLD, other]]));
      expect(r).toEqual({ moved: false });
      expect(ben.calls).toEqual([]);
    }
  });

  it("canMove is only true for an unjoined, unbacked Queue Match the Player opened", () => {
    expect(canMove(match(YOUNG, { seat: 0 }))).toBe(true);
    expect(canMove(match(YOUNG, { seat: 1 }))).toBe(false);
    expect(canMove(match(YOUNG, { seat: null }))).toBe(false);
  });
});
