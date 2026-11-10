import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import { rememberedCarGone } from "./flow";

const key = () => Keypair.generate().publicKey;
const ME = key();
const car = (stage: CarView["stage"], o: Partial<CarView> = {}): CarView => ({ address: key(), opener: key(), n: 0n, stage, seated: 0, pages: 1, ...o }) as CarView;
const seat = (player: PublicKey, seated = true): SeatView => ({ index: 0, seated, player }) as SeatView;

describe("a remembered car that is gone must not hide the car boarding now", () => {
  it("a closed car, or one the Player no longer holds a seat in while it is boarding, is gone", () => {
    expect(rememberedCarGone(null, [], ME)).toBe(true);
    expect(rememberedCarGone(car("closed"), [seat(ME)], ME)).toBe(true);
    expect(rememberedCarGone(car("boarding"), [], ME)).toBe(true);
    expect(rememberedCarGone(car("boarding"), [seat(key())], ME)).toBe(true);
    expect(rememberedCarGone(car("boarding"), [seat(ME, false)], ME)).toBe(true);
  });

  it("a car the Player sits in, or one riding, settling or paid (its Result), stays", () => {
    expect(rememberedCarGone(car("boarding"), [seat(ME)], ME)).toBe(false);
    for (const stage of ["departed", "settling", "refunding", "paid"] as const) expect(rememberedCarGone(car(stage), [], ME)).toBe(false);
  });
});

// The snapshot the page reads, with the chain reads faked: car 8 closed after a "Nobody jumped" ride, car 9 boarding.
const closed = car("closed");
const boarding = car("boarding", { address: key() });
const loads = new Map<string, { car: CarView; seats: SeatView[]; pages: [] }>();
vi.mock("@/lib/chain/many-seat-plan", () => ({ loadCar: async (_r: unknown, match: PublicKey) => loads.get(match.toBase58()) ?? null }));
vi.mock("./chain", async (orig) => ({
  ...(await orig<typeof import("./chain")>()),
  decodeConfig: () => ({ operator: PublicKey.default, tables: 2, nextCar: 9n, boardingMatch: boarding.address }),
  decodeCarAccount: () => ({ table: 0, tesoroMatch: boarding.address }),
}));

describe("readSnapshot with a stale railcar:car key", () => {
  // The hook's module graph loads once, here, with its own generous timeout: a loaded machine slows the import, not the checks.
  let readSnapshot: typeof import("./useRailcar").readSnapshot;
  beforeAll(async () => {
    ({ readSnapshot } = await import("./useRailcar"));
  }, 60_000);

  beforeEach(() => {
    loads.clear();
    loads.set(closed.address.toBase58(), { car: closed, seats: [], pages: [] });
    loads.set(boarding.address.toBase58(), { car: boarding, seats: [], pages: [] });
  });
  const read = { many: async (keys: PublicKey[]) => keys.map(() => ({ data: Buffer.alloc(8) })) } as never;
  const stale = { carNo: "8", table: 0, match: closed.address.toBase58(), matchKey: "x-8" };

  it("forgets the closed car and offers the boarding one (Board no longer tries to open a car that is already boarding)", async () => {
    const s = await readSnapshot(read, async () => null, ME, stale, null);
    expect(s.forgot).toBe(true);
    expect(s.boarding?.loaded.car.address.toBase58()).toBe(boarding.address.toBase58());
    expect(s.car?.match.toBase58()).toBe(boarding.address.toBase58());
    expect(s.mine).toBe(false);
  });

  it("keeps a remembered car the Player really sits in", async () => {
    loads.set(boarding.address.toBase58(), { car: boarding, seats: [seat(ME)], pages: [] });
    const s = await readSnapshot(read, async () => null, ME, { ...stale, carNo: "8", match: boarding.address.toBase58() }, null);
    expect(s.forgot).toBe(false);
    expect(s.mine).toBe(true);
  });
});
