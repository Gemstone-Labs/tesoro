import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair } from "@solana/web3.js";
import { COMMIT_WARN_MS, CommitTracker, commitInFlight, isCommitPending, noteClose } from "./commits.ts";

describe("CommitTracker", () => {
  it("notes a Match once, warns once past 5 minutes, and clears", () => {
    const t = new CommitTracker();
    assert.equal(t.begin("m1", 0), true);
    assert.equal(t.begin("m1", 10), false);
    assert.equal(t.shouldWarn("m1", COMMIT_WARN_MS - 1), false);
    assert.equal(t.shouldWarn("m1", COMMIT_WARN_MS), true);
    assert.equal(t.shouldWarn("m1", COMMIT_WARN_MS + 1), false);
    assert.deepEqual(t.stats(COMMIT_WARN_MS), { commitsPending: 1, oldestCommitPendingSecs: 300 });
    t.clear("m1");
    assert.deepEqual(t.stats(COMMIT_WARN_MS), { commitsPending: 0, oldestCommitPendingSecs: 0 });
  });
});

describe("commit pending detection", () => {
  it("knows the delegation-owned refusal", () => {
    assert.equal(isCommitPending("custom program error: 0xbbf"), true);
    assert.equal(isCommitPending("AnchorError caused by account: duel. Error Code: AccountOwnedByWrongProgram."), true);
    assert.equal(isCommitPending("blockhash not found"), false);
  });

  it("stops resending once a close was sent or the account is delegation-owned", () => {
    const t = new CommitTracker();
    assert.equal(commitInFlight("m1", "[x]", Keypair.generate().publicKey, t, 0), false);
    noteClose("m1", "[x]", { ok: true, detail: "sig" }, t, 0);
    assert.equal(commitInFlight("m1", "[x]", null, t, 1000), true);
    assert.equal(commitInFlight("m2", "[x]", DELEGATION_PROGRAM_ID, t, 0), true);
    assert.equal(t.stats(1000).commitsPending, 2);
  });

  it("does not count other failures", () => {
    const t = new CommitTracker();
    noteClose("m3", "[x]", { ok: false, detail: "blockhash not found" }, t, 0);
    assert.equal(t.has("m3"), false);
  });
});
