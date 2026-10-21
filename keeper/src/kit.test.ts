import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { potBytes, storeBytes, ticketBytes } from "./fixtures.ts";
import { CORE_ID, decodeStore, decodeTicketHead, matchAddress, matchRefOf, POT_AT, slack } from "./kit.ts";

const k = () => Keypair.generate().publicKey;

describe("line stores", () => {
  it("reads a basket: header facts and each line's key and amount", () => {
    const owner = k();
    const [s1, s2] = [k(), k()];
    const bytes = storeBytes([{ source: s1, amount: 40n, dueAt: 7n }, { source: s2, amount: 9n, side: 1, cls: 4, tranche: 1 }], { account: owner, capacity: 5, first: 1, roomReserved: 2 });
    const st = decodeStore(bytes);
    assert.equal(st.account.toBase58(), owner.toBase58());
    assert.deepEqual([st.len, st.first, st.capacity, st.roomReserved], [2, 1, 5, 2]);
    assert.deepEqual([st.lineAt(0).source.toBase58(), st.lineAt(0).amount, st.lineAt(0).dueAt], [s1.toBase58(), 40n, 7n]);
    assert.deepEqual([st.lineAt(1).side, st.lineAt(1).cls, st.lineAt(1).tranche], [1, 4, 1]);
    assert.throws(() => st.lineAt(2));
  });
  it("reads a Pot, whose store starts after the 160 B Ticket head", () => {
    const s = k();
    const st = decodeStore(potBytes([{ source: s, amount: 5n }]), POT_AT);
    assert.deepEqual([st.len, st.lineAt(0).amount], [1, 5n]);
  });
  it("refuses bytes that are not a store", () => {
    assert.throws(() => decodeStore(Buffer.alloc(10)));
    const bad = storeBytes([{ amount: 1n }]);
    bad.writeUInt32LE(99, 8 + 4);
    assert.throws(() => decodeStore(bad));
  });
  it("counts the free room of an Account: both stores, minus what Matches hold", () => {
    const basket = decodeStore(storeBytes([{ amount: 1n }], { capacity: 4 }));
    const spill = decodeStore(storeBytes([], { capacity: 3, roomReserved: 2 }));
    assert.equal(slack(basket, spill), 3 + 3 - 2);
  });
});

describe("Ticket head", () => {
  it("reads kind, state, owner, expiry and the held spill room", () => {
    const account = k();
    const t = decodeTicketHead(ticketBytes({ kind: 1, state: 1, account, nonce: 9n, target: 500n, expiresAt: 1234, spillRoom: 3 }));
    assert.deepEqual([t.kind, t.state, t.nonce, t.target, t.expiresAt, t.spillRoom], ["backing", "cancelling", 9n, 500n, 1234, 3]);
    assert.equal(t.account.toBase58(), account.toBase58());
  });
  it("refuses a head with an unknown state", () => {
    assert.throws(() => decodeTicketHead(ticketBytes({ state: 9, account: k() })));
  });
});

describe("addresses", () => {
  it("a Match lives at ['match', opener, n]", () => {
    const opener = k();
    const ref = matchRefOf({ opener: opener.toBytes(), n: { toString: () => "5" } });
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(5n);
    assert.equal(matchAddress(ref).toBase58(), PublicKey.findProgramAddressSync([Buffer.from("match"), opener.toBuffer(), n], CORE_ID)[0].toBase58());
  });
});
