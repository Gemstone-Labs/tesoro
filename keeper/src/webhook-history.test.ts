import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetCatchUpClock, CATCH_UP_EVERY_MS, webhookCatchUpJob } from "./webhook-history.ts";

const ctx = { settings: { dryRun: false } } as any;
const result = { stored: 2, finalized: 1, decoded: 3, failed: 0 };

describe("the webhook catch-up job", () => {
  afterEach(() => {
    delete process.env.KEEPER_WEBHOOK_HISTORY;
    _resetCatchUpClock();
  });

  it("does nothing unless the webhook history is on", async () => {
    let ran = 0;
    assert.equal(await webhookCatchUpJob(ctx, { now: () => 1e12, run: async () => (ran++, result) }), 0);
    assert.equal(ran, 0);
  });

  it("runs on boot, then every 15 minutes", async () => {
    process.env.KEEPER_WEBHOOK_HISTORY = "1";
    let ran = 0;
    let t = 1e12;
    const deps = { now: () => t, run: async () => (ran++, result) };
    assert.equal(await webhookCatchUpJob(ctx, deps), 2);
    t += CATCH_UP_EVERY_MS - 1;
    assert.equal(await webhookCatchUpJob(ctx, deps), 0);
    t += 1;
    assert.equal(await webhookCatchUpJob(ctx, deps), 2);
    assert.equal(ran, 2);
  });

  it("tries again next pass when the catch-up fails", async () => {
    process.env.KEEPER_WEBHOOK_HISTORY = "1";
    let fail = true;
    const deps = { now: () => 1e12, run: async () => (fail ? Promise.reject(new Error("rpc down")) : result) };
    await assert.rejects(webhookCatchUpJob(ctx, deps));
    fail = false;
    assert.equal(await webhookCatchUpJob(ctx, deps), 2);
  });
});
