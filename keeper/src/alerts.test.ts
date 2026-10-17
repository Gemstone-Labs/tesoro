import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertManager, alertConfig, conditionsOf, lowBalances, postAlert, type Alert, type Condition } from "./alerts.ts";
import { JobTracker } from "./job-stats.ts";

const cfg = alertConfig({});
const MIN = 60_000;
const H = 3_600_000;
const none = { commitsPending: 0, oldestCommitPendingSecs: 0 };

describe("alertConfig", () => {
  it("has defaults and reads every threshold from env", () => {
    assert.equal(cfg.commitPendingSecs, 1800);
    assert.equal(cfg.jobFails, 5);
    assert.equal(cfg.jobStaleSecs, 1800);
    assert.equal(cfg.reminderMs, 4 * H);
    const c = alertConfig({ ALERT_COMMIT_PENDING_SECS: "60", ALERT_JOB_FAILS: "2", ALERT_JOB_STALE_SECS: "90", ALERT_REMINDER_SECS: "600", ALERT_MIN_SOL_ORACLE: "1.5", ALERT_MIN_ETH_RELAYER: "0.2", ALERT_MIN_HYPE_KEEPER: "9" });
    assert.deepEqual([c.commitPendingSecs, c.jobFails, c.jobStaleSecs, c.reminderMs], [60, 2, 90, 600_000]);
    assert.equal(c.minSol.oracle, 1.5);
    assert.equal(c.minEth.relayer, 0.2);
    assert.equal(c.minHype.keeper, 9);
  });

  it("ignores junk numbers", () => {
    assert.equal(alertConfig({ ALERT_JOB_FAILS: "lots" }).jobFails, 5);
  });
});

describe("conditionsOf", () => {
  it("is quiet when everything is fine", () => {
    const j = new JobTracker();
    j.ok("price", 0);
    assert.deepEqual(conditionsOf({ health: none, jobs: j.entries(), balances: [] }, cfg, 1000), []);
  });

  it("flags commits pending past the threshold, not before", () => {
    const at = (secs: number) => conditionsOf({ health: { commitsPending: 2, oldestCommitPendingSecs: secs }, jobs: [], balances: [] }, cfg, 0);
    assert.deepEqual(at(1800), []);
    const [c] = at(1801);
    assert.equal(c.key, "commits");
    assert.match(c.detail, /2 .*1801s|30 min/);
  });

  it("flags a job that throws repeatedly", () => {
    const j = new JobTracker();
    j.ok("price", 0);
    for (let i = 0; i < 4; i++) j.fail("price", "rpc down", 10 + i);
    assert.deepEqual(conditionsOf({ health: none, jobs: j.entries(), balances: [] }, cfg, 20), []);
    j.fail("price", "rpc down", 20);
    const [c] = conditionsOf({ health: none, jobs: j.entries(), balances: [] }, cfg, 20);
    assert.equal(c.key, "job:price");
    assert.match(c.detail, /5 .*rpc down/);
  });

  it("flags a job with no success for the stale window (hung or skipped)", () => {
    const j = new JobTracker();
    j.ok("bridge", 0);
    assert.deepEqual(conditionsOf({ health: none, jobs: j.entries(), balances: [] }, cfg, 1800_000), []);
    const [c] = conditionsOf({ health: none, jobs: j.entries(), balances: [] }, cfg, 1801_000);
    assert.equal(c.key, "job:bridge");
    assert.match(c.detail, /30 min|1801s/);
  });

  it("flags a balance under its minimum", () => {
    const bal = [
      { key: "balance:keeper:solana", label: "keeper on Solana", unit: "SOL", amount: 0.1, min: 0.3, address: "KeepeR1" },
      { key: "balance:oracle:solana", label: "oracle on Solana", unit: "SOL", amount: 0.2, min: 0.2, address: "OraclE1" },
    ];
    const out = lowBalances(bal);
    assert.deepEqual(out.map((c) => c.key), ["balance:keeper:solana"]);
    assert.match(out[0].detail, /0\.1 SOL.*0\.3 SOL.*KeepeR1/);
    assert.deepEqual(conditionsOf({ health: none, jobs: [], balances: bal }, cfg, 0).map((c) => c.key), ["balance:keeper:solana"]);
  });
});

describe("AlertManager", () => {
  const cond = (key = "commits", detail = "stuck"): Condition => ({ key, title: `${key} title`, detail });
  function setup(ok = true) {
    const sent: Alert[] = [];
    const m = new AlertManager(async (a) => (sent.push(a), ok), 4 * H);
    return { m, sent };
  }

  it("sends one alert when a condition starts, then nothing on later ticks", async () => {
    const { m, sent } = setup();
    await m.update([cond()], 0);
    await m.update([cond()], 20_000);
    await m.update([cond()], 40_000);
    assert.deepEqual(sent.map((a) => a.kind), ["alert"]);
    assert.equal(sent[0].key, "commits");
    assert.equal(sent[0].detail, "stuck");
  });

  it("reminds at most once per reminder interval while it lasts", async () => {
    const { m, sent } = setup();
    await m.update([cond()], 0);
    await m.update([cond()], 4 * H - 1);
    assert.equal(sent.length, 1);
    await m.update([cond("commits", "still stuck")], 4 * H);
    assert.deepEqual(sent.map((a) => a.kind), ["alert", "reminder"]);
    assert.equal(sent[1].detail, "still stuck");
    await m.update([cond()], 4 * H + 20_000);
    await m.update([cond()], 8 * H - 1);
    assert.equal(sent.length, 2);
    await m.update([cond()], 8 * H);
    assert.deepEqual(sent.map((a) => a.kind), ["alert", "reminder", "reminder"]);
  });

  it("sends recovered once when the condition clears, and alerts again if it returns", async () => {
    const { m, sent } = setup();
    await m.update([cond()], 0);
    await m.update([], 20_000);
    await m.update([], 40_000);
    assert.deepEqual(sent.map((a) => a.kind), ["alert", "recovered"]);
    assert.equal(sent[1].key, "commits");
    await m.update([cond()], 60_000);
    assert.deepEqual(sent.map((a) => a.kind), ["alert", "recovered", "alert"]);
  });

  it("tracks conditions independently", async () => {
    const { m, sent } = setup();
    await m.update([cond("a")], 0);
    await m.update([cond("a"), cond("b")], 1000);
    await m.update([cond("b")], 2000);
    assert.deepEqual(sent.map((a) => `${a.kind}:${a.key}`), ["alert:a", "alert:b", "recovered:a"]);
  });

  it("retries a failed send on the next tick instead of losing the alert", async () => {
    const sent: Alert[] = [];
    let up = false;
    const m = new AlertManager(async (a) => (sent.push(a), up), 4 * H);
    await m.update([cond()], 0);
    await m.update([cond()], 20_000);
    up = true;
    await m.update([cond()], 40_000);
    await m.update([cond()], 60_000);
    assert.deepEqual(sent.map((a) => a.kind), ["alert", "alert", "alert"]);
  });

  it("retries a failed recovery too", async () => {
    const sent: Alert[] = [];
    let up = true;
    const m = new AlertManager(async (a) => (sent.push(a), up), 4 * H);
    await m.update([cond()], 0);
    up = false;
    await m.update([], 1000);
    up = true;
    await m.update([], 2000);
    await m.update([], 3000);
    assert.deepEqual(sent.map((a) => a.kind), ["alert", "recovered", "recovered"]);
  });

  it("never throws when the sender does", async () => {
    const m = new AlertManager(async () => {
      throw new Error("boom");
    }, H);
    await m.update([cond()], 0);
  });
});

describe("postAlert", () => {
  const alert: Alert = { kind: "alert", key: "k", title: "t", detail: "d", source: "test" };
  it("posts to <NOTIFY_URL>alert with the shared secret", async () => {
    let seen: { url: string; init: any } | undefined;
    const ok = await postAlert("https://h.example/api/notify/", "sek", alert, (async (url: string, init: any) => ((seen = { url, init }), { ok: true })) as any);
    assert.equal(ok, true);
    assert.equal(seen?.url, "https://h.example/api/notify/alert");
    assert.equal(seen?.init.headers.authorization, "Bearer sek");
    assert.deepEqual(JSON.parse(seen?.init.body), alert);
  });
  it("is false on a refusal or a network error", async () => {
    assert.equal(await postAlert("https://h.example/api/notify/", "s", alert, (async () => ({ ok: false })) as any), false);
    assert.equal(await postAlert("https://h.example/api/notify/", "s", alert, (async () => { throw new Error("x"); }) as any), false);
  });
});

describe("readBalances", () => {
  it("skips a balance that cannot be read", async () => {
    const { readBalances } = await import("./alerts.ts");
    const w = (key: string) => ({ key, label: key, unit: "SOL", min: 1, address: "A", net: "solana" });
    const out = await readBalances([w("a"), w("b")], async (x) => {
      if (x.key === "b") throw new Error("rpc");
      return 0.5;
    });
    assert.deepEqual(out.map((r) => [r.key, r.amount]), [["a", 0.5]]);
  });
});
