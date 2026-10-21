import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointCandidates, decodeLines, matchAddress, POT_AT, potLineCount, potPayer, potSources, potSponsored, potTotal, receiptPda, stageOf } from "./match-accounts";

/** A Pot as tesoro_core's `open_match` made it in a LiteSVM run of the block_puzzle suite (regenerate: WRITE_POT_FIXTURE=<path> cargo test -p block_puzzle a_real_pot). */
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "pot.json"), "utf8")) as { hex: string; lines: { source: string; amount: string }[]; total: string; payer: string };
const pot = Uint8Array.from(Buffer.from(fixture.hex, "hex"));

describe("a real Pot", () => {
  it("decodes to the lines the program drew", () => {
    const lines = decodeLines(pot, POT_AT);
    expect(lines.map((l) => ({ source: l.source.toBase58(), amount: l.amount.toString() }))).toEqual(fixture.lines);
  });
  it("reads its totals, line count and payer", () => {
    expect(potTotal(pot).toString()).toBe(fixture.total);
    expect(potLineCount(pot)).toBe(fixture.lines.length);
    expect(potPayer(pot).toBase58()).toBe(fixture.payer);
    expect(potSponsored(pot)).toBe(0n);
  });
  it("names each Source once", () => {
    expect(potSources([pot, null, pot]).map((k) => k.toBase58())).toEqual([...new Set(fixture.lines.map((l) => l.source))]);
  });
});

describe("addresses", () => {
  const opener = Keypair.generate().publicKey;
  it("a Match is its opener's account and number", () => {
    expect(matchAddress(opener, 0n).equals(matchAddress(opener, 1n))).toBe(false);
    expect(matchAddress(opener, 3n).equals(matchAddress(opener, 3))).toBe(true);
    expect(matchAddress(Keypair.generate().publicKey, 3n).equals(matchAddress(opener, 3n))).toBe(false);
  });
  it("the receipt follows the Match", () => {
    const m = matchAddress(opener, 0n);
    expect(receiptPda(m).equals(receiptPda(matchAddress(opener, 1n)))).toBe(false);
  });
  it("a book can have 15 classes of 4 checkpoint pages", () => {
    const c = checkpointCandidates(PublicKey.default);
    expect(c).toHaveLength(60);
    expect(new Set(c.map((k) => k.toBase58())).size).toBe(60);
  });
  it("reads the Stage enum", () => {
    expect(stageOf({ settling: {} })).toBe("settling");
    expect(stageOf({ closed: {} })).toBe("closed");
  });
});

describe("a store whose first lines were drawn", () => {
  it("starts reading at `first`", () => {
    const body = Buffer.alloc(128 + 3 * 144);
    body.writeUInt32LE(2, 4); // len
    body.writeUInt32LE(1, 92); // first
    const at = (slot: number) => 128 + slot * 144;
    const src = Keypair.generate().publicKey;
    for (const [slot, amount] of [[1, 7n], [2, 9n]] as const) {
      body[at(slot)] = 0;
      body[at(slot) + 1] = 3;
      src.toBuffer().copy(body, at(slot) + 11);
      body.writeBigUInt64LE(amount, at(slot) + 43);
    }
    const lines = decodeLines(new Uint8Array(body), 0);
    expect(lines.map((l) => l.amount)).toEqual([7n, 9n]);
    expect(lines[0].source.equals(src)).toBe(true);
  });
});
