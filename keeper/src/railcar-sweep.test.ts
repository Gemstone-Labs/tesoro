import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import type { TableView } from "../../app/src/games/railcar/chain.ts";
import type { RideStep } from "../../app/src/games/railcar/flow.ts";
import type { CarView } from "../../app/src/lib/chain/many-seat.ts";
import { COMMIT_RETRY_SECS, RIDE_CAP_SECS, sweepRideAction } from "./railcar-sweep.ts";

const T0 = 1_800_000_000;
const car = (over: Partial<CarView> = {}) => ({ address: Keypair.generate().publicKey, stage: "departed", departedAt: T0 - 900, refundAfter: T0 + 86_400, ...over }) as CarView;
const table = (over: Partial<TableView> = {}) => ({ phase: "riding", rideTs: T0 - 300, dirty: false, commitAt: 0, ...over }) as TableView;
const act = (kind: RideStep["kind"], o: { core?: Partial<CarView>; rollup?: TableView | null; now?: number } = {}) =>
  sweepRideAction({ kind, ...(kind === "finalize-previous" ? { carNo: 3n } : {}) } as RideStep, { core: car(o.core), rollup: o.rollup === undefined ? table() : o.rollup, now: o.now ?? T0 });

describe("the sweep's step for a Railcar ride whose pages are gone", () => {
  it("sends what a page would: the departure, the ride's start, finalize", () => {
    assert.deepEqual(act("depart", { core: { stage: "boarding" } }), { send: "depart" });
    assert.deepEqual(act("start-ride"), { send: "start-ride" });
    assert.deepEqual(act("finalize"), { send: "finalize" });
  });

  it("signals a ride still inside its cap only as a look (not a try), and as a step once the cap is over", () => {
    assert.deepEqual(act("signal", { rollup: table({ rideTs: T0 - 60 }) }), { send: "signal", untilOver: true });
    assert.deepEqual(act("signal", { rollup: table({ rideTs: T0 - RIDE_CAP_SECS }) }), { send: "signal", untilOver: false });
    assert.deepEqual(act("signal", { rollup: table({ phase: "drawing" }) }), { send: "signal", untilOver: true });
  });

  it("commits again only when the result is owed or the last commit may be lost", () => {
    assert.deepEqual(act("commit", { rollup: table({ phase: "over", dirty: true }) }), { send: "commit" });
    assert.deepEqual(act("commit", { rollup: table({ phase: "over", commitAt: T0 - 10 }) }), { wait: "the commit is on its way to base" });
    assert.deepEqual(act("commit", { rollup: table({ phase: "over", commitAt: T0 - COMMIT_RETRY_SECS }) }), { send: "commit" });
  });

  it("refunds through core 24 h after departure, unless base already holds the result", () => {
    const late = { now: T0 + 86_400, core: { refundAfter: T0 + 86_400 } };
    for (const kind of ["signal", "start-ride", "commit", "wait", "finalize-previous"] as const) assert.deepEqual(act(kind, late), { send: "refund" }, kind);
    assert.deepEqual(act("finalize", late), { send: "finalize" });
  });

  it("leaves the Table's previous car, and the finisher's steps, to their own turn", () => {
    assert.ok("wait" in act("finalize-previous"));
    assert.ok("wait" in act("wait"));
    assert.ok("wait" in act("settle", { core: { stage: "settling" } }));
  });
});
