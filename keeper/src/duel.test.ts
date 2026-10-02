import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STATUS } from "../../app/src/games/trading-duel/chain.ts";
import { duelStep, END_GRACE_SECS } from "./duel.ts";

const duel = (status: number, over: Partial<{ finalized: boolean; startDeadline: number; endsAt: number }> = {}) => ({
  status,
  finalized: false,
  startDeadline: 1300,
  endsAt: 2000,
  ...over,
});
const DAY = 86_400;

describe("Trading Duel hygiene (base layer)", () => {
  it("finalizes an over or cancelled Duel, never a finalized one", () => {
    assert.equal(duelStep(duel(STATUS.over), "base", 5, 10).do, "finalize");
    assert.equal(duelStep(duel(STATUS.cancelled), "base", 5, 10).do, "finalize");
    assert.equal(duelStep(duel(STATUS.over, { finalized: true }), "base", 5, 10).do, "wait");
  });

  it("refunds a never-delegated Created Duel once the start deadline is strictly past", () => {
    assert.equal(duelStep(duel(STATUS.created), "base", 1301, 1000 + DAY).do, "finalize");
    assert.equal(duelStep(duel(STATUS.created), "base", 1300, 1000 + DAY).do, "wait");
  });

  it("refunds through tesoro_core only at the Match deadline for other states", () => {
    assert.equal(duelStep(duel(STATUS.live), "base", 9, 10).do, "wait");
    assert.equal(duelStep(duel(STATUS.live), "base", 10, 10).do, "refund");
  });
});

describe("Trading Duel hygiene (rollup)", () => {
  it("cancels a delegated, never-started Duel after its start deadline", () => {
    assert.equal(duelStep(duel(STATUS.created), "tee", 1300, 0).do, "wait");
    assert.equal(duelStep(duel(STATUS.created), "tee", 1301, 0).do, "claim_timeout");
  });

  it("leaves the first try at ending to the Players, then ends the Match", () => {
    assert.equal(duelStep(duel(STATUS.live), "tee", 1999, 0).do, "wait");
    assert.equal(duelStep(duel(STATUS.live), "tee", 2000 + END_GRACE_SECS - 1, 0).do, "wait");
    assert.equal(duelStep(duel(STATUS.live), "tee", 2000 + END_GRACE_SECS, 0).do, "end_match");
  });

  it("closes an over or cancelled Duel that is still in the rollup", () => {
    assert.equal(duelStep(duel(STATUS.over), "tee", 1, 0).do, "close_match");
    assert.equal(duelStep(duel(STATUS.cancelled), "tee", 1, 0).do, "close_match");
  });
});
