import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { matchPda } from "./basket";
import { waitingForMatch, waitingForMatchAt, type WaitingRecord } from "./overflow";

const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const OPENER = k(9);
const rec = (n: number, gemas: bigint, match: PublicKey | null = matchPda(OPENER, n)): WaitingRecord => ({ address: k(n), owner: k(2), payer: k(3), kind: 0, match, gemas, lines: 1, storeLines: [], sources: [k(4)] });

describe("waitingForMatch", () => {
  it("keeps only the records of this Match", () => {
    const got = waitingForMatch([rec(7, 95n), rec(8, 71n)], `${OPENER.toBase58()}-7`);
    expect(got.map((r) => r.gemas)).toEqual([95n]);
  });
  it("ignores Season and route records and empty records", () => {
    expect(waitingForMatch([rec(7, 5n, null), rec(7, 0n)], `${OPENER.toBase58()}-7`)).toEqual([]);
  });
  it("is empty for a key that names no Match, and once the records are claimed", () => {
    expect(waitingForMatch([rec(7, 95n)], "7")).toEqual([]);
    expect(waitingForMatch([], `${OPENER.toBase58()}-7`)).toEqual([]);
  });
});

describe("waitingForMatchAt", () => {
  it("takes the Match address itself (a many-seat car), same filter", () => {
    const at = matchPda(OPENER, 7);
    expect(waitingForMatchAt([rec(7, 95n), rec(8, 71n)], at).map((r) => r.gemas)).toEqual([95n]);
  });
});
