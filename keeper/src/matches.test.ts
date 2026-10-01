import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STATUS } from "../../app/src/games/holdem/chain.ts";
import { baseTableStep } from "./matches.ts";

const created = (startDeadline: number) => ({ status: STATUS.created, finalized: false, startDeadline });
const DAY = 86_400;

describe("Hold'em table on the base layer (SP-05)", () => {
  it("finalizes a never-delegated Created table once the 5-minute start deadline passes", () => {
    // create_match at t=1000: start_deadline 1300, tesoro_core deadline pushed to 1000 + 24 h.
    const step = baseTableStep(created(1300), 1301, 1000 + DAY);
    assert.equal(step.do, "finalize");
    assert.match(step.why, /no-show/);
  });

  it("waits until the start deadline is strictly past (finalize requires now > start_deadline)", () => {
    assert.equal(baseTableStep(created(1300), 1300, 1000 + DAY).do, "wait");
    assert.equal(baseTableStep(created(1300), 1200, 1000 + DAY).do, "wait");
  });

  it("finalizes over and cancelled tables, and refunds other tables at the Match deadline", () => {
    assert.equal(baseTableStep({ status: STATUS.over, finalized: false, startDeadline: 0 }, 5, 10).do, "finalize");
    assert.equal(baseTableStep({ status: STATUS.cancelled, finalized: false, startDeadline: 0 }, 5, 10).do, "finalize");
    assert.equal(baseTableStep({ status: STATUS.live, finalized: false, startDeadline: 0 }, 5, 10).do, "wait");
    assert.equal(baseTableStep({ status: STATUS.live, finalized: false, startDeadline: 0 }, 10, 10).do, "refund");
  });
});
