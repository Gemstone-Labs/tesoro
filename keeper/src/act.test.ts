import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { runJob } from "./act.ts";
import { jobs } from "./job-stats.ts";

describe("runJob (OC-05)", () => {
  it("moves on from a hung job and skips it until it finishes", async () => {
    let release!: () => void;
    let calls = 0;
    const hung = () => (calls++, new Promise<number>((r) => (release = () => r(0))));
    const started = Date.now();
    await runJob("hung", hung, {}, 50);
    assert.ok(Date.now() - started < 1000);
    await runJob("hung", hung, {}, 50);
    assert.equal(calls, 1, "a run still going is not started twice");
    release();
    await new Promise((r) => setTimeout(r, 0));
    await runJob("hung", async () => (calls++, 0), {}, 50);
    assert.equal(calls, 2);
  });

  it("contains a job's error", async () => {
    await runJob("boom", async () => Promise.reject(new Error("rpc down")), {}, 50);
  });
});

test("an untracked run leaves the alerts' job record alone", async () => {
  await runJob("quiet-job", async () => 0, {}, 50, false);
  await runJob("quiet-job-failing", async () => Promise.reject(new Error("x")), {}, 50, false);
  const names = jobs.entries().map(([n]) => n);
  assert.ok(!names.includes("quiet-job") && !names.includes("quiet-job-failing"));
});
