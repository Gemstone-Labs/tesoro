import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import workedExample from "./many-seat-ahead.worked-example.fixtures.json";
import refund from "./many-seat-ahead.refund.fixtures.json";
import hundred from "./many-seat-ahead.hundred.fixtures.json";
import { carAhead, decodeCar, decodePage, isCar, type CarAhead } from "./many-seat-plan";

/**
 * The TypeScript port of core's `ManySeatRecord::ahead` against core itself: Railcar's LiteSVM settle runs
 * (programs/railcar/tests/ride.rs, `TESORO_RAILCAR_FIXTURE`) wrote, before each chunk, the car's and its pages' raw
 * bytes, every seat's Pot lines and the accounts Rust's `ahead` named for the chunk's steps.
 */

interface Case {
  chunk: number;
  steps: number;
  match: string;
  pages: string[];
  lines: [string, string][][];
  ahead: { pages: number[]; seats: number[]; owners: string[]; sources: string[]; cutSources: string[] };
}

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const ADDRESS = new PublicKey(new Uint8Array(32).fill(7));

function portOf(c: Case): CarAhead {
  const car = decodeCar(ADDRESS, bytes(c.match));
  const seats = c.pages.flatMap((p) => decodePage(ADDRESS, bytes(p)).seats);
  const lines = c.lines.map((ls) => ls.map(([source, amount]) => ({ source: new PublicKey(source), amount: BigInt(amount) })));
  return carAhead(car, seats, lines, c.steps);
}

const named = (a: CarAhead) => ({ pages: a.pages, seats: a.seats, owners: a.owners.map(String), sources: a.sources.map(String), cutSources: a.cutSources.map(String) });

describe.each([
  ["the worked example (places and an early refund)", workedExample.cases as Case[]],
  ["a full refund (nobody jumped)", refund.cases as Case[]],
  ["a hundred seats", hundred.cases as Case[]],
])("the next chunk's accounts: %s", (_name, cases) => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(0));
  it.each(cases.map((c) => [c.chunk, c] as const))("chunk %i names what core's ahead names", (_n, c) => {
    expect(named(portOf(c))).toEqual(c.ahead);
  });
});

describe("decoding a car", () => {
  const c = workedExample.cases[0] as Case;
  it("reads the worked example's car as core wrote it", () => {
    const car = decodeCar(ADDRESS, bytes(c.match));
    expect([car.stage, car.seated, car.pages, car.entry, car.minSeats, car.maxSeats]).toEqual(["settling", 5, 1, 500n, 5, 100]);
    expect(car.run.nPlaces).toBe(3);
    expect(car.run.places.slice(0, 3).map((p) => p.shareBps)).toEqual([6000, 2500, 1500]);
    expect(car.departedAt).toBeGreaterThan(0);
    expect(car.refundAfter - car.departedAt).toBe(24 * 60 * 60);
  });
  it("tells a car from other accounts", () => {
    expect(isCar(bytes(c.match))).toBe(true);
    expect(isCar(bytes(c.pages[0]))).toBe(false);
  });
});
