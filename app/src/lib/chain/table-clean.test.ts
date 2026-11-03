import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { settledPda } from "./basket";
import { atNextEpoch, beginSettled, startNote } from "./table-clean";

const key = () => Keypair.generate().publicKey;
const slot = (state: number, tesoroMatch: PublicKey) => ({ state, tesoroMatch });
const free = () => slot(0, PublicKey.default);

describe("atNextEpoch", () => {
  const table = { generation: 0, index: 3, epoch: 4 };
  it("is the Assignment exactly one epoch ahead on the same table", () => {
    expect(atNextEpoch({ generation: 0, index: 3, epoch: 5 }, table)).toBe(true);
  });
  it("is not any other epoch or another table", () => {
    expect(atNextEpoch({ generation: 0, index: 3, epoch: 4 }, table)).toBe(false);
    expect(atNextEpoch({ generation: 0, index: 3, epoch: 6 }, table)).toBe(false);
    expect(atNextEpoch({ generation: 0, index: 2, epoch: 5 }, table)).toBe(false);
    expect(atNextEpoch({ generation: 1, index: 3, epoch: 5 }, table)).toBe(false);
  });
});

describe("startNote", () => {
  it("says the table is being cleared once the previous Match is finished, so a begin that only cleared does not look stuck", () => {
    expect(startNote(true)).toBe("Clearing the table, then starting your Match");
    expect(startNote(false)).toBe("Starting the Match");
  });
});

describe("beginSettled", () => {
  it("names the receipt of the Match the table holds, for a table stuck on one", () => {
    const m = key();
    const t = { tesoroMatch: m, ring: [slot(1, m), free(), free(), free(), free(), free(), free(), free()] };
    expect(beginSettled(t).map(String)).toEqual([String(settledPda(m))]);
  });

  it("adds the receipt of every ring slot when the ring is full", () => {
    const ms = Array.from({ length: 8 }, key);
    const t = { tesoroMatch: PublicKey.default, ring: ms.map((m) => slot(2, m)) };
    expect(beginSettled(t).map(String).sort()).toEqual(ms.map((m) => String(settledPda(m))).sort());
  });

  it("names a Match once even when the table and a slot both hold it", () => {
    const ms = Array.from({ length: 8 }, key);
    const t = { tesoroMatch: ms[0], ring: ms.map((m) => slot(1, m)) };
    expect(beginSettled(t)).toHaveLength(8);
  });

  it("names nothing for a clean table with room in its ring", () => {
    const t = { tesoroMatch: PublicKey.default, ring: [slot(2, key()), free(), free(), free(), free(), free(), free(), free()] };
    expect(beginSettled(t)).toEqual([]);
  });
});
