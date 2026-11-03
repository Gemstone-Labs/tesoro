import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HEARTBEAT_EVERY_MS, Heartbeat, heartbeatFrom, pingHeartbeat } from "./heartbeat.ts";

const recorder = (fail = false) => {
  const calls: string[] = [];
  const fetchFn = (async (u: string | URL | Request) => {
    calls.push(String(u));
    if (fail) throw new Error("network down");
    return new Response("OK");
  }) as typeof fetch;
  return { calls, fetchFn };
};

describe("pingHeartbeat", () => {
  it("pings the URL for ok and URL/fail for a failed run", async () => {
    const r = recorder();
    assert.equal(await pingHeartbeat("https://hc.example/ping/abc", "ok", r.fetchFn), true);
    assert.equal(await pingHeartbeat("https://hc.example/ping/abc/", "fail", r.fetchFn), true);
    assert.deepEqual(r.calls, ["https://hc.example/ping/abc", "https://hc.example/ping/abc/fail"]);
  });

  it("never throws: a dead network is false", async () => {
    assert.equal(await pingHeartbeat("https://hc.example/x", "ok", recorder(true).fetchFn), false);
  });

  it("gives up on a hung monitor after the timeout", async () => {
    // The real socket keeps the event loop alive; this fake needs its own ref'd timer (AbortSignal.timeout is unref'd).
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        const keepAlive = setTimeout(() => {}, 5_000);
        init?.signal?.addEventListener("abort", () => (clearTimeout(keepAlive), rej(new Error("aborted"))));
      })) as typeof fetch;
    assert.equal(await pingHeartbeat("https://hc.example/x", "ok", hang, 20), false);
  });
});

describe("Heartbeat", () => {
  it("is off without a URL and logs that once", async () => {
    const lines: string[] = [];
    const r = recorder();
    const hb = heartbeatFrom("KEEPER_HEARTBEAT_URL", {}, r.fetchFn, (m) => lines.push(m));
    assert.equal(hb.enabled, false);
    assert.equal(await hb.ping("ok"), false);
    assert.equal(await hb.pingIfDue(10 * HEARTBEAT_EVERY_MS), false);
    assert.deepEqual(r.calls, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /off.*KEEPER_HEARTBEAT_URL/);
  });

  it("pings after each run, and otherwise at most every 5 minutes", async () => {
    const r = recorder();
    const hb = new Heartbeat("https://hc.example/p", r.fetchFn);
    assert.equal(await hb.pingIfDue(0), true);
    assert.equal(await hb.pingIfDue(HEARTBEAT_EVERY_MS - 1), false);
    assert.equal(await hb.pingIfDue(HEARTBEAT_EVERY_MS), true);
    await hb.ping("ok", HEARTBEAT_EVERY_MS + 1_000);
    assert.equal(await hb.pingIfDue(HEARTBEAT_EVERY_MS + 2_000), false);
    assert.equal(r.calls.length, 3);
  });

  it("a failed ping does not move the cadence, so the next tick retries", async () => {
    const hb = new Heartbeat("https://hc.example/p", recorder(true).fetchFn);
    assert.equal(await hb.pingIfDue(0), false);
    assert.equal(await hb.pingIfDue(1), false);
  });

  it("reads the URL from the named env var", () => {
    assert.equal(heartbeatFrom("SEASON_HEARTBEAT_URL", { SEASON_HEARTBEAT_URL: " https://hc.example/s " }, fetch, () => {}).enabled, true);
  });
});

describe("one heartbeat URL per job", () => {
  it("names are distinct, and only the main loop reads the keeper's", async () => {
    const { HEARTBEAT_ENV } = await import("./heartbeat.ts");
    assert.equal(new Set(Object.values(HEARTBEAT_ENV)).size, Object.values(HEARTBEAT_ENV).length);
    assert.equal(HEARTBEAT_ENV.sweep, "SWEEP_HEARTBEAT_URL");
    const { readdirSync, readFileSync } = await import("node:fs");
    const users = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && readFileSync(new URL(f, import.meta.url), "utf8").includes("HEARTBEAT_ENV.loop"));
    assert.deepEqual(users, ["index.ts"], "a monitor shared between jobs stays green when one of them dies");
  });
});
