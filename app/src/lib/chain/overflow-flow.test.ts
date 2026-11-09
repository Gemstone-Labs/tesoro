import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DISC, basketPda, bookPda, ckptPda, spillPda } from "./basket";
import { encodeBook, encodeStore, freshClass, lineOf } from "./basket-fixture";
import { OVERFLOW_DISC, OVERFLOW_STORE_AT, decodeOverflowRecord } from "./overflow";
import { claimInstruction } from "./overflow-flow";

const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const OWNER = k(7);
const SOURCE = k(2);

function recordData(lines: ReturnType<typeof lineOf>[]): Buffer {
  const store = encodeStore(lines, { account: OWNER, capacity: 4 });
  const out = Buffer.alloc(OVERFLOW_STORE_AT + store.length - DISC);
  OVERFLOW_DISC.forEach((b, i) => (out[i] = b));
  k(8).toBuffer().copy(out, DISC);
  store.copy(out, OVERFLOW_STORE_AT, DISC);
  return out;
}

/** The chain as the 2026-11-09 Railcar case left it: the Source's General class is at checkpoint 1; the Account holds a line from before it (ck 0) and the record a fresher one (ck 1) of the same key. */
function chain() {
  const general = { ...freshClass(), epoch: 1, ck: 1 };
  const accounts = new Map<string, Buffer>([
    [bookPda(SOURCE).toBase58(), encodeBook([freshClass(), freshClass(), freshClass(), general])],
    [basketPda(OWNER).toBase58(), encodeStore([lineOf({ side: 1, source: SOURCE, amount: 95n, dueAt: 5n, uncovered: 1000n, epoch: 0, ck: 0 })], { account: OWNER, capacity: 4 })],
    [spillPda(OWNER).toBase58(), encodeStore([], { account: OWNER, capacity: 0 })],
  ]);
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => (accounts.has(key.toBase58()) ? ({ data: accounts.get(key.toBase58())! } as never) : null)) };
}

describe("claimInstruction", () => {
  it("passes the checkpoint page of the stale line a claim merges into (MissingCheckpoint 6165 otherwise)", async () => {
    const record = decodeOverflowRecord(k(1), recordData([lineOf({ side: 1, source: SOURCE, amount: 71n, dueAt: 5n, epoch: 1, ck: 1 })]))!;
    const ix = await claimInstruction(chain(), record);
    const keys = ix.keys.map((m) => m.pubkey.toBase58());
    expect(keys).toContain(bookPda(SOURCE).toBase58());
    expect(keys).toContain(ckptPda(SOURCE, 3, 0).toBase58());
    expect(ix.keys.find((m) => m.pubkey.equals(ckptPda(SOURCE, 3, 0)))!.isWritable).toBe(true);
  });
  it("passes only the book when no line is stale", async () => {
    const record = decodeOverflowRecord(k(1), recordData([lineOf({ side: 1, source: k(3), amount: 5n })]))!;
    const ix = await claimInstruction(chain(), record);
    expect(ix.keys.some((m) => m.pubkey.equals(ckptPda(k(3), 3, 0)))).toBe(false);
  });
});
