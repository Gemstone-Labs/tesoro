import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainMatch } from "@/lib/chain/read";
import { BurstDriver, type BurstDriverDeps } from "./burst-driver";
import { ASSIGNED, SECS, blankTable, fixtureAssignment, fixtureKey } from "./live-fixtures";
import { TABLE_PHASE, type Table } from "./live-chain";
import { OPENER_EXTRA_MS } from "./live-driver";

const opener = fixtureKey(2);
const joiner = fixtureKey(3);
const matchKey = `${fixtureKey(7).toBase58()}-0`;

const activeMatch = (seat: 0 | 1): ChainMatch => ({ id: matchKey, status: "active", running: null, seat, backerSeat: null, deadline: 4_000_000_000, entry: 100, opponent: null }) as unknown as ChainMatch;

const seatedTable = (over: Partial<Table> = {}) => blankTable({ phase: TABLE_PHASE.assigned, seatsOpen: false, ...over });

/** A chain whose table the test moves by hand, and that records every step the driver sends. */
function fakeChain(initial: Table) {
  let table = initial;
  let push: ((t: Table) => void) | null = null;
  const sent: { step: string; at: number }[] = [];
  const record = (step: string) => async () => {
    sent.push({ step, at: Date.now() });
    return "sig";
  };
  const chain = {
    onTx: undefined,
    readAssignment: async () => fixtureAssignment({ startDeadline: 4_000_000_000 }),
    readTable: async () => table,
    readTableOnBase: async () => null,
    readOwnBoard: async () => null,
    currentSlot: async () => ASSIGNED + 5 * SECS,
    watchTable: async (_v: unknown, _a: unknown, cb: (t: Table) => void) => {
      push = cb;
      return () => undefined;
    },
    beginMatch: record("beginMatch"),
    seatPlayers: record("seatPlayers"),
    checkIn: record("checkIn"),
    requestSeed: record("requestSeed"),
    start: record("start"),
    close: record("close"),
    commitTable: record("commitTable"),
    finalize: record("finalize"),
  };
  return {
    chain: chain as unknown as BurstDriverDeps["chain"],
    sent,
    /** The rollup writes the table: the websocket pushes it. */
    move(next: Table) {
      table = next;
      push?.(next);
    },
  };
}

function driverFor(seat: 0 | 1, fake: ReturnType<typeof fakeChain>) {
  const who = seat === 0 ? opener : joiner;
  const signer = { publicKey: who, signTransaction: async (t: never) => t, signMessage: async () => new Uint8Array(64) };
  return new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, getToken: async () => null, chain: fake.chain, fetchMatch: async () => activeMatch(seat) });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BurstDriver", () => {
  it("the joiner does a step anyone may do as soon as it sees the table, not after a wait for the keeper", async () => {
    const fake = fakeChain(seatedTable());
    const d = driverFor(1, fake);
    d.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.sent.map((s) => s.step)).toEqual(["seatPlayers"]);
    d.stop();
  });

  it("the opener follows within two seconds when the joiner did not", async () => {
    const fake = fakeChain(seatedTable());
    const d = driverFor(0, fake);
    d.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(OPENER_EXTRA_MS + 400);
    expect(fake.sent.map((s) => s.step)).toEqual(["seatPlayers"]);
    expect(fake.sent[0].at).toBeLessThanOrEqual(Date.now());
    d.stop();
  });

  it("acts on the websocket's push at once, without waiting for the next one-second tick", async () => {
    const fake = fakeChain(seatedTable({ seatsOpen: true, checkedIn: [true, true], phase: TABLE_PHASE.assigned }));
    const d = driverFor(1, fake);
    d.start();
    await vi.advanceTimersByTimeAsync(1_100);
    fake.sent.length = 0;
    // Half a second after a tick, the rollup writes: both checked in, seeding.
    await vi.advanceTimersByTimeAsync(500);
    const pushedAt = Date.now();
    fake.move(seatedTable({ seatsOpen: true, checkedIn: [true, true], phase: TABLE_PHASE.seeding, seedingSlot: ASSIGNED + 3 * SECS }));
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.sent.map((s) => s.step)).toEqual(["requestSeed"]);
    expect(fake.sent[0].at - pushedAt).toBeLessThan(100);
    d.stop();
  });
});

describe("BurstDriver, reads", () => {
  it("a push that changes nothing the driver decides on (a score during the run) does not run it again", async () => {
    const running = blankTable({ phase: TABLE_PHASE.getReady, seatsOpen: true, checkedIn: [true, true], seedReady: true, startSlot: ASSIGNED + 1 * SECS });
    let reads = 0;
    const fake = fakeChain(running);
    const fetchMatch = async () => (reads++, activeMatch(1));
    const signer = { publicKey: joiner, signTransaction: async (t: never) => t, signMessage: async () => new Uint8Array(64) };
    const d = new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, getToken: async () => null, chain: fake.chain, fetchMatch });
    d.start();
    await vi.advanceTimersByTimeAsync(1_500);
    const before = reads;
    for (let i = 0; i < 20; i++) fake.move({ ...running, shownScore: [i, 0], shownMoves: [i, 0] });
    await vi.advanceTimersByTimeAsync(50);
    expect(reads).toBe(before);
    d.stop();
  });

  it("the second page to see the committed table waits for the first to finalize", async () => {
    const closed = blankTable({ phase: TABLE_PHASE.closed, seatsOpen: true, dirty: false, checkedIn: [true, true], startSlot: ASSIGNED });
    const committed = { ...closed, ring: [{ state: 2, tesoroMatch: closed.tesoroMatch, epoch: 4, outcome: 1, at: 1 }] };
    const sentBy = async (seat: 0 | 1) => {
      const fake = fakeChain(closed);
      let base: Table | null = null;
      (fake.chain as unknown as { readTableOnBase: () => Promise<Table | null> }).readTableOnBase = async () => base;
      const d = driverFor(seat, fake);
      d.start();
      await vi.advanceTimersByTimeAsync(2_000);
      base = committed as Table; // the commit lands on base while the rollup's table stays as it was
      const landedAt = Date.now();
      await vi.advanceTimersByTimeAsync(3_000);
      d.stop();
      return fake.sent.filter((s) => s.step === "finalize").map((s) => s.at - landedAt);
    };
    const [joinerAt] = await sentBy(1);
    const [openerAt] = await sentBy(0);
    expect(joinerAt).toBeLessThan(1_200);
    expect(openerAt).toBeGreaterThanOrEqual(1_200);
  });
});

describe("BurstDriver, waiting for a table", () => {
  it("looks for the Assignment twice a second, not once", async () => {
    const fake = fakeChain(seatedTable());
    let asks = 0;
    let assigned = false;
    (fake.chain as unknown as { readAssignment: () => Promise<unknown> }).readAssignment = async () => (asks++, assigned ? fixtureAssignment({ startDeadline: 4_000_000_000 }) : null);
    const d = driverFor(1, fake);
    d.start();
    await vi.advanceTimersByTimeAsync(2_000);
    assigned = true;
    asks = 0;
    await vi.advanceTimersByTimeAsync(700);
    expect(asks).toBeGreaterThanOrEqual(1);
    expect(fake.sent.map((s) => s.step)).toEqual(["seatPlayers"]);
    d.stop();
  });
});

describe("BurstDriver, the result", () => {
  const fixed = (running: "settling" | null): ChainMatch => ({ ...activeMatch(1), status: "settled", running, settled: { fee: 6, delta: 94, points: null } }) as unknown as ChainMatch;

  it("shows the result as soon as it is fixed, keeps reading while the chunks pay, and refreshes the Player's Gemas once, at the end", async () => {
    let state: ChainMatch | null = fixed("settling");
    let reads = 0;
    let refreshed = 0;
    const fake = fakeChain(seatedTable());
    const signer = { publicKey: joiner, signTransaction: async (t: never) => t, signMessage: async () => new Uint8Array(64) };
    const d = new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, getToken: async () => null, chain: fake.chain, fetchMatch: async () => (reads++, state), onSettled: () => void refreshed++ });
    d.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(d.view.stage).toBe("settled");
    expect(refreshed).toBe(0);
    const before = reads;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reads).toBeGreaterThan(before + 1);
    expect(d.view.stage).toBe("settled");
    state = fixed(null);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(refreshed).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refreshed).toBe(1);
    d.stop();
  });

  it("an account that closed before the history has its row still ends the Match", async () => {
    let state: ChainMatch | null = fixed("settling");
    let refreshed = 0;
    const fake = fakeChain(seatedTable());
    const signer = { publicKey: joiner, signTransaction: async (t: never) => t, signMessage: async () => new Uint8Array(64) };
    const d = new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, getToken: async () => null, chain: fake.chain, fetchMatch: async () => state, onSettled: () => void refreshed++ });
    d.start();
    await vi.advanceTimersByTimeAsync(300);
    state = null;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(d.view.stage).toBe("settled");
    expect(refreshed).toBe(1);
    d.stop();
  });
});

describe("BurstDriver, a page that missed the whole settle run", () => {
  it("ends on the result from the settlement receipt when the account closed unseen and the history cannot be read", async () => {
    let state: ChainMatch | null = { ...activeMatch(1), sides: [{}, {}] } as unknown as ChainMatch;
    let refreshed = 0;
    const fake = fakeChain(seatedTable());
    (fake.chain as unknown as { tesoro: unknown }).tesoro = { account: { settlementReceipt: { fetchNullable: async () => ({ receipt: { kind: { win: { winner: 0 } } } }) } } };
    const signer = { publicKey: joiner, signTransaction: async (t: never) => t, signMessage: async () => new Uint8Array(64) };
    const d = new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, getToken: async () => null, chain: fake.chain, fetchMatch: async () => state, onSettled: () => void refreshed++ });
    d.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(d.view.stage).not.toBe("settled");
    state = null; // closed while this page was not looking; /api/match has no row (no database)
    await vi.advanceTimersByTimeAsync(1_500);
    expect(d.view.stage).toBe("settled");
    expect(d.view.match?.status).toBe("settled");
    expect(d.view.match?.winner).toBe("opener");
    expect(refreshed).toBe(1);
    d.stop();
  });
});
