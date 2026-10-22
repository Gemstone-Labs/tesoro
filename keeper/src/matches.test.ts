import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openQueueStep } from "./blockpuzzle.ts";

const DAY = 86_400;

describe("Block Burst Queue window", () => {
  it("holds an unjoined Match for 24 h from open_session, and an older one for its 1 h", () => {
    const opened = 1000;
    const deadline = opened + DAY;
    assert.equal(openQueueStep(opened + 3601, deadline), "wait");
    assert.equal(openQueueStep(deadline - 1, deadline), "wait");
    assert.equal(openQueueStep(deadline, deadline), "refund");
    assert.equal(openQueueStep(opened + 3601, opened + 3600), "refund");
  });
});
