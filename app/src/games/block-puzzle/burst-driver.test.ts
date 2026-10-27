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
  return new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, chain: fake.chain, fetchMatch: async () => activeMatch(seat) });
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
