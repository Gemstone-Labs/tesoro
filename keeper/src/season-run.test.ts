import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAYOUT_WINDOW_SECS, SEASON_EPOCH, SEASON_SECS } from "../../app/src/lib/chain/season.ts";
import { memoryStore, seasonRun, stepsDue, type StepName, type Steps } from "./season-run.ts";

const monday = SEASON_EPOCH + 3 * SEASON_SECS;
const mondayRun = monday + 15 * 60;
const wednesdayRun = monday + PAYOUT_WINDOW_SECS + 30 * 60;

/** Steps that log their calls; `script[name]` lists the results of that step's passes (default: done at once). */
function fake(script: Partial<Record<StepName, ("fail" | "more" | "done")[]>> = {}) {
  const calls: StepName[] = [];
  const steps = Object.fromEntries(
    (["settle", "redeem", "harvest", "batches", "pools", "record", "pay"] as StepName[]).map((name) => [
      name,
      async () => {
        calls.push(name);
        const next = script[name]?.shift() ?? "done";
        if (next === "fail") throw new Error(`${name} failed`);
        return { actions: 1, pending: next === "more" };
      },
    ]),
  ) as Steps;
  return { calls, steps };
}

describe("when the steps are due", () => {
  it("does nothing before Monday 00:15 UTC, runs Monday's steps until Wednesday, then all of them", () => {
    assert.deepEqual(stepsDue(monday + 14 * 60), []);
    assert.deepEqual(stepsDue(mondayRun), ["settle", "redeem", "harvest", "batches", "pools", "record"]);
    assert.deepEqual(stepsDue(wednesdayRun - 60), ["settle", "redeem", "harvest", "batches", "pools", "record"]);
    assert.equal(stepsDue(wednesdayRun).at(-1), "pay");
  });
});

describe("the weekly Season run", () => {
  it("drains Settling Matches first and records last on Monday, and does not pay", async () => {
    const { calls, steps } = fake();
    const report = await seasonRun(mondayRun, steps, memoryStore());
    assert.deepEqual(calls, ["settle", "redeem", "harvest", "batches", "pools", "record"]);
    assert.equal(report.stoppedAt, null);
  });

  it("repeats a step while it has more to do", async () => {
    const { calls, steps } = fake({ settle: ["more", "more", "done"] });
    await seasonRun(mondayRun, steps, memoryStore());
    assert.deepEqual(calls.slice(0, 4), ["settle", "settle", "settle", "redeem"]);
  });

  it("stops at a failed step and resumes there on the hourly retry", async () => {
    const store = memoryStore();
    const first = fake({ harvest: ["fail"] });
    const a = await seasonRun(mondayRun, first.steps, store);
    assert.equal(a.stoppedAt, "harvest");
    assert.deepEqual(first.calls, ["settle", "redeem", "harvest"], "later steps wait for the failed one");
    const retry = fake();
    const b = await seasonRun(mondayRun + 3600, retry.steps, store);
    assert.deepEqual(retry.calls, ["harvest", "batches", "pools", "record"], "settle and redeem are not repeated");
    assert.equal(b.stoppedAt, null);
  });

  it("stops a step that never finishes after its passes", async () => {
    const { steps } = fake({ record: ["more", "more", "more"] });
    const report = await seasonRun(mondayRun, steps, memoryStore(), 3);
    assert.equal(report.stoppedAt, "record");
  });

  it("pays on Wednesday only, and only the steps Monday left undone come first", async () => {
    const store = memoryStore();
    await seasonRun(mondayRun, fake().steps, store);
    const early = fake();
    await seasonRun(wednesdayRun - 3600, early.steps, store);
    assert.deepEqual(early.calls, [], "before the window has passed nothing is paid");
    const wed = fake();
    const report = await seasonRun(wednesdayRun, wed.steps, store);
    assert.deepEqual(wed.calls, ["pay"]);
    assert.equal(report.stoppedAt, null);
  });

  it("starts the steps over in a new Season but keeps the empty Seasons", async () => {
    const store = memoryStore({ season: 3, done: ["settle", "redeem", "harvest", "batches", "pools", "record", "pay"], empty: [1] });
    const next = fake();
    await seasonRun(mondayRun + SEASON_SECS, next.steps, store);
    assert.equal(next.calls.length, 6);
    assert.deepEqual(store.load()?.empty, [1]);
  });

  it("keeps the empty Seasons a step recorded while it ran", async () => {
    const store = memoryStore();
    const { steps } = fake();
    steps.record = async () => {
      store.save({ ...(store.load() ?? { season: 0, done: [] }), empty: [2] } as never);
      return { actions: 0, pending: false };
    };
    await seasonRun(mondayRun, steps, store);
    assert.deepEqual(store.load()?.empty, [2]);
  });
});

describe("a step that reports a failure without throwing", () => {
  /** Runs the Monday steps with `harvest` reporting `failed` subjects (as the jobs do), muting the log. */
  async function runWith(failed: { subject: string }[], store = memoryStore()) {
    const { noteError } = await import("./errors.ts");
    const { failOnErrors } = await import("./season-run.ts");
    const { calls, steps } = fake();
    const inner = steps.harvest;
    steps.harvest = async () => {
      const r = await inner();
      for (const f of failed) noteError("harvest", f.subject, new Error("send failed"));
      return r;
    };
    const quiet = console.log;
    console.log = () => {};
    try {
      return { calls, store, report: await seasonRun(mondayRun, failOnErrors(steps), store) };
    } finally {
      console.log = quiet;
    }
  }

  it("stops at that step when a failure belongs to no Source, and the retry resumes there", async () => {
    const a = await runWith([{ subject: "pool=ABCD..wxyz" }]);
    assert.equal(a.report.stoppedAt, "harvest");
    assert.deepEqual(a.calls, ["settle", "redeem", "harvest"]);
    const retry = fake();
    const b = await seasonRun(mondayRun + 3600, retry.steps, a.store);
    assert.deepEqual(retry.calls, ["harvest", "batches", "pools", "record"]);
    assert.equal(b.stoppedAt, null);
  });

  it("stops when only some failures name a Source", async () => {
    const a = await runWith([{ subject: "source=AAAA..bbbb" }, { subject: "match=7" }]);
    assert.equal(a.report.stoppedAt, "harvest");
  });

  it("skips the Sources whose actions failed, reports them, and goes on to record", async () => {
    const a = await runWith([{ subject: "source=AAAA..bbbb" }, { subject: "source=CCCC..dddd" }, { subject: "source=AAAA..bbbb" }]);
    assert.equal(a.report.stoppedAt, null);
    assert.deepEqual(a.calls, ["settle", "redeem", "harvest", "batches", "pools", "record"]);
    assert.deepEqual(a.report.skipped, [
      { step: "harvest", source: "AAAA..bbbb" },
      { step: "harvest", source: "CCCC..dddd" },
    ]);
    assert.ok(a.store.load()?.done.includes("harvest"));
  });
});
