import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import workedExample from "./many-seat-ahead.worked-example.fixtures.json";
import refund from "./many-seat-ahead.refund.fixtures.json";
import hundred from "./many-seat-ahead.hundred.fixtures.json";
import { decodeCar, decodeSeatPage } from "./many-seat";
import { aheadOf, type SeatAhead } from "./many-seat-plan";

/**
 * The TypeScript `aheadOf` against core's own `ManySeatRecord::ahead`: Railcar's LiteSVM settle runs
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

function portOf(c: Case): SeatAhead {
  const car = decodeCar(ADDRESS, bytes(c.match));
  const seats = c.pages.flatMap((p) => decodeSeatPage(bytes(p)).seats);
  const lines = c.lines.map((ls) => ls.map(([source, amount]) => ({ source: new PublicKey(source), amount: BigInt(amount) })));
  return aheadOf(car, seats, lines, c.steps);
}

const named = (a: SeatAhead) => ({ pages: a.pages, seats: a.seats, owners: a.owners.map(String), sources: a.sources.map(String), cutSources: a.cutSources.map(String) });

describe.each([
  ["the worked example (places and an early refund)", workedExample.cases as unknown as Case[]],
  ["a full refund (nobody jumped)", refund.cases as unknown as Case[]],
  ["a hundred seats (refunds, places, fee cuts)", hundred.cases as unknown as Case[]],
])("the next chunk's accounts, as core names them: %s", (_name, cases) => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(0));
  it.each(cases.map((c) => [c.chunk, c] as const))("chunk %i", (_n, c) => {
    expect(named(portOf(c))).toEqual(c.ahead);
  });
});
