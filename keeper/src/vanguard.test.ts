import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PENDING, STATUS } from "../../app/src/games/vanguard/decode.ts";
import { CU } from "../../app/src/games/vanguard/chain.ts";
import { RULES_VERSION } from "../../app/src/games/vanguard/rules.ts";
import { GRACE_SECS, SETUP_ASSIST_SECS, setupMove, vanguardStep, windDown, type BattleFacts } from "./vanguard.ts";

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
  rulesVersion: RULES_VERSION,
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

  it("resolves a declared Blast, Rescue or pass like a move (a pass names no piece, so nothing else differs)", () => {
    for (const pendingKind of [PENDING.blast, PENDING.rescue, PENDING.pass]) {
      const b = battle(STATUS.live, { pendingKind, pendingSlot: 100n });
      assert.equal(tee(b, 1500, 101n).do, "resolve", `kind ${pendingKind}`);
      assert.equal(tee(b, 1500, 100n).do, "wait", `kind ${pendingKind} in its declare slot`);
    }
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
    assert.equal(tee(battle(STATUS.setup), 1400 + GRACE_SECS).do, "assist_setup");
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

describe("a Battle the rollup stopped serving (the tesoro_core deadline passes)", () => {
  it("refunds the Match whatever state the rollup last showed, except a finished Battle", () => {
    for (const status of [STATUS.created, STATUS.setup, STATUS.live]) {
      assert.equal(vanguardStep(battle(status), "tee", 10, 10, 0n).do, "refund");
      assert.equal(vanguardStep(battle(status, { pendingKind: PENDING.move, pendingSlot: 1n }), "tee", 11, 10, 9n).do, "refund");
      assert.notEqual(vanguardStep(battle(status), "tee", 9, 10, 0n).do, "refund");
    }
    assert.equal(vanguardStep(battle(STATUS.over, { permissioned: true }), "tee", 11, 10, 0n).do, "close_match");
  });
});

describe("setup that stalls", () => {
  it("is helped along while it is inside its window, and cancelled once past it", () => {
    assert.equal(tee(battle(STATUS.setup), 1400 + GRACE_SECS).do, "assist_setup");
    assert.equal(tee(battle(STATUS.setup), 1401 + GRACE_SECS).do, "claim_timeout");
  });

  it("deals when the deal would go through, whatever the randomness request did", () => {
    assert.equal(setupMove({ canDeal: true, canRequest: true, now: 100, lastRequestAt: 0, setupStartedAt: 0 }), "deal");
  });

  it("asks for the randomness once both secrets are in and nothing is stored, but not on every pass", () => {
    const base = { canDeal: false, canRequest: true, setupStartedAt: 100 };
    assert.equal(setupMove({ ...base, now: 100 + SETUP_ASSIST_SECS, lastRequestAt: 0 }), "request_vrf");
    assert.equal(setupMove({ ...base, now: 100 + SETUP_ASSIST_SECS + 5, lastRequestAt: 100 + SETUP_ASSIST_SECS }), "wait");
    assert.equal(setupMove({ ...base, now: 100 + SETUP_ASSIST_SECS + 20, lastRequestAt: 100 + SETUP_ASSIST_SECS }), "request_vrf");
  });

  it("leaves the first seconds to the Players' clients, and does nothing while a secret is missing", () => {
    assert.equal(setupMove({ canDeal: false, canRequest: true, now: 103, lastRequestAt: 0, setupStartedAt: 100 }), "wait");
    assert.equal(setupMove({ canDeal: false, canRequest: false, now: 500, lastRequestAt: 0, setupStartedAt: 100 }), "wait");
  });
});

describe("the wind-down of Battles on older rules", () => {
  const old = (status: number, over: Partial<BattleFacts> = {}) => battle(status, { rulesVersion: RULES_VERSION - 1, ...over });

  it("claims a timeout at once on an older-rules Battle that is Created, in Setup or Live, whatever its clocks say", () => {
    for (const status of [STATUS.created, STATUS.setup, STATUS.live]) {
      const step = tee(old(status), 1000);
      assert.equal(step.do, "claim_timeout", `status ${status}`);
      assert.match(step.why, /rules version/);
    }
  });

  it("does so even with a pending action, which the claim clears", () => {
    for (const pendingKind of [PENDING.move, PENDING.timeout, PENDING.cap]) {
      assert.equal(tee(old(STATUS.live, { pendingKind, pendingSlot: 1n }), 1000, 9n).do, "claim_timeout");
      assert.equal(tee(old(STATUS.live, { pendingKind, pendingSlot: 1n }), 1000, 0n).do, "claim_timeout");
    }
  });

  it("leaves current-rules Battles to their clocks", () => {
    assert.equal(windDown(battle(STATUS.live)), false);
    assert.equal(tee(battle(STATUS.live), 1000).do, "wait");
    assert.equal(tee(battle(STATUS.setup), 1000).do, "assist_setup");
  });

  it("never touches an over Battle: it is closed and settled as usual, and the Match deadline still refunds first", () => {
    assert.equal(windDown(old(STATUS.over)), false);
    assert.equal(tee(old(STATUS.over, { permissioned: true }), 5).do, "close_match");
    assert.equal(vanguardStep(old(STATUS.live), "tee", 1000 + DAY, 1000 + DAY, 0n).do, "refund");
  });

  it("closes what the claim cancelled, so the normal finalize refunds it", () => {
    assert.equal(tee(old(STATUS.cancelled, { permissioned: true }), 5).do, "close_match");
    assert.equal(tee(old(STATUS.cancelled, { permissioned: false }), 5).do, "close_unstarted");
    assert.equal(vanguardStep(old(STATUS.cancelled), "base", 5, 10, 0n).do, "finalize");
  });

  it("leaves an older-rules Battle on the base layer to its start deadline and the Match refund", () => {
    assert.equal(vanguardStep(old(STATUS.created), "base", 1301, 1000 + DAY, 0n).do, "finalize");
    assert.equal(vanguardStep(old(STATUS.live), "base", 9, 10, 0n).do, "wait");
  });
});

describe("compute budgets", () => {
  // ticket vgp 06, LiteSVM on compiled SBF: the worst declare and resolve, 30% headroom
  it("cover the program's worst measured declare and resolve with 30% headroom", () => {
    assert.ok(CU.declare >= 5_090 * 1.3, `declare budget ${CU.declare}`);
    assert.ok(CU.resolve >= 146_052 * 1.3, `resolve budget ${CU.resolve}`);
  });
});
