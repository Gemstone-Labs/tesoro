import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { Raced, act, finalizeOrRaced, runJob, runJobs, stillRunning } from "./act.ts";
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

test("runJobs gives the caller a turn after every job, so a short job is never stuck behind a long pass", async () => {
  const seen: string[] = [];
  const job = (n: string) => [n, async () => (seen.push(n), 0)] as [string, (c: unknown) => Promise<number>];
  await runJobs([job("a"), job("b")], {}, async () => void seen.push("between"));
  assert.deepEqual(seen, ["a", "between", "b", "between"]);
});

test("runJobs works without a between hook, and the hook sees a job that is still running after its limit", async () => {
  const seen: string[] = [];
  await runJobs([["x", async () => (seen.push("x"), 0)]], {});
  assert.deepEqual(seen, ["x"]);
  let release = () => {};
  const slow = new Promise<void>((r) => (release = r));
  let orphan = false;
  await runJobs([["slow", async () => (await slow, 0)]], {}, async () => void (orphan = stillRunning()), 20);
  assert.equal(orphan, true);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stillRunning(), false);
});

test("an action that finds its step already done by someone else is a wait, not a failure", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => void lines.push(m);
  try {
    const rt = { settings: { dryRun: false }, budget: { exhausted: () => false }, conn: {}, payer: {} } as never;
    const r = await act(rt, "match", "match=x", "close (over)", async () => { throw new Raced("closed by another caller"); });
    assert.equal(r.ok, false);
    assert.ok(lines.some((l) => l.includes("wait: close (over) not needed")));
    assert.ok(!lines.some((l) => l.includes("FAIL")));
  } finally {
    console.log = orig;
  }
});

const RACE_ERR = `finalize failed 5GJV4wFF: {"InstructionError":[1,{"Custom":0}]}\nProgram log: Instruction: Finalize\nProgram log: Instruction: SettleMatch\nAllocate: account Address { address: Cg2cERyekdTHT9X2hYVbZEa1jVgGzdvEeLkCsVpSgQXm, base: None } already in use\nProgram 1111 failed: custom program error: 0x0`;

async function runFinalize(chain: { finalize: () => Promise<string>; finalizeIx: () => Promise<unknown> }) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => void lines.push(m);
  try {
    const rt = { settings: { dryRun: false }, budget: { exhausted: () => false }, conn: {}, payer: {} } as never;
    const r = await act(rt, "match", "match=CJZQ-18", "finalize (the committed table holds the result)", () => finalizeOrRaced(chain as never, { publicKey: {} } as never, {} as never));
    return { r, lines };
  } finally {
    console.log = orig;
  }
}

test("a finalize that lost the race to the page's is a wait, not a failure", async () => {
  const { r, lines } = await runFinalize({
    finalize: async () => { throw new Error(RACE_ERR); },
    finalizeIx: async () => null, // the Match reads as settled now
  });
  assert.equal(r.detail, "raced");
  assert.ok(lines.some((l) => l.includes("wait: finalize") && l.includes("not needed")));
  assert.ok(!lines.some((l) => l.includes("FAIL")));
});

test("a finalize that fails while the Match is still unsettled stays a FAIL", async () => {
  const { r, lines } = await runFinalize({
    finalize: async () => { throw new Error("finalize failed x: NoResult"); },
    finalizeIx: async () => ({}),
  });
  assert.equal(r.ok, false);
  assert.ok(lines.some((l) => l.includes("FAIL finalize")));
});
