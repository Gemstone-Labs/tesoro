import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SharedReads, pollConfirm } from "./runtime.ts";

/** Statuses in order, one per poll (the last repeats); block height grows by one per poll. */
function fakeConn(statuses: (null | { err: unknown; confirmationStatus?: string })[]) {
  let i = 0;
  let height = 100;
  return {
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [statuses[Math.min(i++, statuses.length - 1)]] }),
    getBlockHeight: async () => height++,
  } as any;
}

describe("pollConfirm (no websocket needed)", () => {
  it("returns once the signature is confirmed, however long the RPC takes to see it", async () => {
    const r = await pollConfirm(fakeConn([null, null, { err: null, confirmationStatus: "confirmed" }]), { signature: "s", lastValidBlockHeight: 150 }, 1);
    assert.deepEqual(r.value, { err: null });
  });

  it("returns a landed failure as the transaction error, not as an expiry", async () => {
    const r = await pollConfirm(fakeConn([{ err: { InstructionError: [1, { Custom: 6018 }] }, confirmationStatus: "processed" }]), { signature: "s", lastValidBlockHeight: 150 }, 1);
    assert.deepEqual(r.value.err, { InstructionError: [1, { Custom: 6018 }] });
  });

  it("throws the expiry error only once the blockhash expired with the signature unknown", async () => {
    await assert.rejects(pollConfirm(fakeConn([null]), { signature: "s", lastValidBlockHeight: 102 }, 1), (e: Error) => e.name === "TransactionExpiredBlockheightExceededError");
  });
});

describe("pollConfirm speed", () => {
  it("checks about every 0.4 s by default, so a transaction that landed is known within a second", async () => {
    const t = Date.now();
    await pollConfirm(fakeConn([null, null, { err: null, confirmationStatus: "confirmed" }]), { signature: "s", lastValidBlockHeight: 150 });
    const took = Date.now() - t;
    assert.ok(took >= 700 && took < 1100, `took ${took} ms`);
  });
});

describe("SharedReads", () => {
  it("shares one read for the same key, and reads again after clear", async () => {
    let reads = 0;
    const shared = new SharedReads(5000);
    const read = async () => ++reads;
    assert.equal(await shared.get("a", read), 1);
    assert.equal(await shared.get("a", read), 1);
    shared.clear();
    assert.equal(await shared.get("a", read), 2);
  });
});
