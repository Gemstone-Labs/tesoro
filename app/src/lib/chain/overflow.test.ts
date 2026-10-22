import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DISC, basketPda, spillPda } from "./basket";
import { encodeStore, lineOf } from "./basket-fixture";
import { CLAIM_LINES, OVERFLOW_DISC, OVERFLOW_OWNER_AT, OVERFLOW_STORE_AT, claimOverflowIx, decodeOverflowRecord, waitingGemas } from "./overflow";

const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

/** A record as the program writes it: discriminator, head (payer, kind, id), then a basket-format store of the owner. */
function record(owner: PublicKey, payer: PublicKey, kind: number, lines: { source: PublicKey; amount: bigint }[], capacity = 4): Buffer {
  const store = encodeStore(lines.map((l) => lineOf({ side: 1, ...l })), { account: owner, capacity });
  const out = Buffer.alloc(OVERFLOW_STORE_AT + store.length - DISC);
  OVERFLOW_DISC.forEach((b, i) => (out[i] = b));
  payer.toBuffer().copy(out, DISC);
  out[DISC + 32] = kind;
  store.copy(out, OVERFLOW_STORE_AT, DISC);
  return out;
}

describe("overflow records", () => {
  it("has the discriminator Anchor derives for the account type", () => {
    expect([...OVERFLOW_DISC]).toEqual([...createHash("sha256").update("account:OverflowHead").digest().subarray(0, 8)]);
  });
  it("keeps the owner Account at the byte a list by owner filters on", () => {
    const data = record(k(7), k(8), 0, []);
    expect(new PublicKey(data.subarray(OVERFLOW_OWNER_AT, OVERFLOW_OWNER_AT + 32)).toBase58()).toBe(k(7).toBase58());
  });
  it("reads who it belongs to, who paid, and the Gemas waiting", () => {
    const rec = decodeOverflowRecord(k(1), record(k(7), k(8), 1, [{ source: k(2), amount: 40n }, { source: k(3), amount: 2n }]));
    expect(rec).toMatchObject({ kind: 1, gemas: 42n, lines: 2 });
    expect(rec!.owner.toBase58()).toBe(k(7).toBase58());
    expect(rec!.payer.toBase58()).toBe(k(8).toBase58());
    expect(rec!.sources.map((s) => s.toBase58())).toEqual([k(2).toBase58(), k(3).toBase58()]);
    expect(waitingGemas([rec!, rec!])).toBe(84n);
  });
  it("refuses bytes that are not a record", () => {
    expect(decodeOverflowRecord(k(1), Buffer.alloc(400))).toBeNull();
    expect(decodeOverflowRecord(k(1), Buffer.from("short"))).toBeNull();
    const wrong = record(k(7), k(8), 0, []);
    wrong[0] ^= 1;
    expect(decodeOverflowRecord(k(1), wrong)).toBeNull();
  });
  it("builds claim_overflow with the owner's stores, the record, who paid it and the books", () => {
    const rec = decodeOverflowRecord(k(1), record(k(7), k(8), 0, [{ source: k(2), amount: 5n }]))!;
    const book = k(9);
    const ix = claimOverflowIx(rec, [book]);
    const keys = ix.keys.map((m) => m.pubkey.toBase58());
    for (const want of [k(7), basketPda(k(7)), spillPda(k(7)), k(1), k(8), book]) expect(keys).toContain(want.toBase58());
    expect(ix.keys.some((m) => m.isSigner)).toBe(false);
    expect(ix.data.subarray(8)[0]).toBe(CLAIM_LINES);
    // a Match record names its Match, so the claim can close the record once the Match is gone
    expect(rec.match).not.toBeNull();
    expect(keys).toContain(rec.match!.toBase58());
    expect(decodeOverflowRecord(k(1), record(k(7), k(8), 1, []))!.match).toBeNull();
  });
});
