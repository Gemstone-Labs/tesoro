import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runJob } from "./act.ts";

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
