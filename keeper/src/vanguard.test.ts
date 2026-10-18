import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PENDING, STATUS } from "../../app/src/games/vanguard/decode.ts";
import { GRACE_SECS, vanguardStep, type BattleFacts } from "./vanguard.ts";

const DAY = 86_400;
const battle = (status: number, over: Partial<BattleFacts> = {}): BattleFacts => ({
  status,
  finalized: false,
  permissioned: false,
  startDeadline: 1300,
  entropyDeadline: 1400,
  setupDeadline: 1480,
  deadline: 2000,
  capDeadline: 3000,
  pendingKind: PENDING.none,
  pendingSlot: 0n,
  ...over,
});
const tee = (b: BattleFacts, now: number, slot = 100n) => vanguardStep(b, "tee", now, 1000 + DAY, slot);

describe("Vanguard hygiene (base layer)", () => {
  it("finalizes an over or cancelled Battle, never a finalized one", () => {
    assert.equal(vanguardStep(battle(STATUS.over), "base", 5, 10, 0n).do, "finalize");
    assert.equal(vanguardStep(battle(STATUS.cancelled), "base", 5, 10, 0n).do, "finalize");
    assert.equal(vanguardStep(battle(STATUS.over, { finalized: true }), "base", 5, 10, 0n).do, "wait");
  });

  it("finalizes a never-delegated Created Battle once its start deadline is strictly past", () => {
    assert.equal(vanguardStep(battle(STATUS.created), "base", 1301, 1000 + DAY, 0n).do, "finalize");
    assert.equal(vanguardStep(battle(STATUS.created), "base", 1300, 1000 + DAY, 0n).do, "wait");
  });

  it("refunds through tesoro_core at the Match deadline for a Battle stuck on the base layer", () => {
    assert.equal(vanguardStep(battle(STATUS.live), "base", 9, 10, 0n).do, "wait");
    assert.equal(vanguardStep(battle(STATUS.live), "base", 10, 10, 0n).do, "refund");
  });
});

describe("Vanguard hygiene (rollup)", () => {
  it("resolves a pending action once the slot is past its declare slot", () => {
    const b = battle(STATUS.live, { pendingKind: PENDING.move, pendingSlot: 100n });
    assert.equal(tee(b, 1500, 101n).do, "resolve");
    assert.equal(tee(b, 1500, 100n).do, "wait");
    assert.equal(tee(battle(STATUS.live, { pendingKind: PENDING.timeout, pendingSlot: 5n }), 1500, 6n).do, "resolve");
    assert.equal(tee(battle(STATUS.live, { pendingKind: PENDING.cap, pendingSlot: 5n }), 1500, 6n).do, "resolve");
  });

  it("resolves before it considers any clock", () => {
    const b = battle(STATUS.live, { pendingKind: PENDING.move, pendingSlot: 1n, deadline: 10, capDeadline: 10 });
    assert.equal(tee(b, 5000, 2n).do, "resolve");
  });

  it("cancels a delegated Battle that never started once the start window is strictly past", () => {
    assert.equal(tee(battle(STATUS.created), 1301).do, "claim_timeout");
    assert.equal(tee(battle(STATUS.created), 1300).do, "wait");
  });

  it("cancels a Battle stuck in setup past the entropy or setup deadline", () => {
    assert.equal(tee(battle(STATUS.setup), 1400 + GRACE_SECS).do, "wait");
    assert.equal(tee(battle(STATUS.setup), 1401 + GRACE_SECS).do, "claim_timeout");
  });

  it("claims a timeout only GRACE_SECS after an expired turn", () => {
    assert.equal(tee(battle(STATUS.live), 2000 + GRACE_SECS).do, "wait");
    assert.equal(tee(battle(STATUS.live), 2001 + GRACE_SECS).do, "claim_timeout");
  });

  it("claims the time cap GRACE_SECS after it, even while the turn clock is fresh", () => {
    const b = battle(STATUS.live, { deadline: 9999 });
    assert.equal(tee(b, 3000 + GRACE_SECS).do, "wait");
    assert.equal(tee(b, 3001 + GRACE_SECS).do, "claim_timeout");
  });

  it("closes an over Battle still in the rollup, an unstarted cancelled one without permissions", () => {
    assert.equal(tee(battle(STATUS.over, { permissioned: true }), 5).do, "close_match");
    assert.equal(tee(battle(STATUS.cancelled, { permissioned: true }), 5).do, "close_match");
    assert.equal(tee(battle(STATUS.cancelled, { permissioned: false }), 5).do, "close_unstarted");
  });

  it("always says why it waits", () => {
    assert.match(tee(battle(STATUS.live), 1500).why, /turn|deadline/i);
  });
});
