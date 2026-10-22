import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { MAX_ACCOUNTS, MAX_TX_BYTES, accountCount, fits, wireSize } from "./send.ts";

const payer = Keypair.generate().publicKey;
const ixWith = (n: number): TransactionInstruction =>
  new TransactionInstruction({
    programId: SystemProgram.programId,
    data: Buffer.alloc(0),
    keys: Array.from({ length: n }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })),
  });

describe("what fits one transaction", () => {
  it("counts the accounts and the bytes", () => {
    const ix = ixWith(10);
    assert.equal(accountCount(payer, [ix]), 12, "10 accounts, the fee payer and the program");
    assert.ok(wireSize(payer, [ix]) > 10 * 32);
  });
  it("accepts a small transaction and refuses one with too many bytes", () => {
    assert.equal(fits(payer, [ixWith(5)]), true);
    assert.equal(fits(payer, [ixWith(40)]), false, "40 accounts are more than 1,232 bytes without a lookup table");
  });
  it("limits are the network's", () => {
    assert.deepEqual([MAX_TX_BYTES, MAX_ACCOUNTS], [1232, 64]);
  });
});
