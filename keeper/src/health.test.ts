import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommitTracker } from "./commits.ts";
import { Health, startHealthServer, startWatchdog } from "./health.ts";

describe("Health", () => {
  it("is alive until no pass has finished for staleMs", () => {
    const h = new Health(1000, 0);
    assert.equal(h.status(1000).alive, true);
    assert.equal(h.status(1001).alive, false);
    h.beat(true, 1001);
    assert.deepEqual(h.status(2000), { alive: true, passes: 1, failedInARow: 0, lastPassSecsAgo: 1, commitsPending: 0, oldestCommitPendingSecs: 0 });
  });

  it("counts failed passes in a row and resets on a clean one", () => {
    const h = new Health(1000, 0);
    h.beat(false, 1);
    h.beat(false, 2);
    assert.equal(h.status(2).failedInARow, 2);
    h.beat(true, 3);
    assert.equal(h.status(3).failedInARow, 0);
  });
});

describe("Health commits", () => {
  it("reports the Matches waiting on a commit and the oldest age", () => {
    const t = new CommitTracker();
    const h = new Health(1000, 0, t);
    t.begin("match=1", 0);
    t.begin("match=2", 4000);
    assert.deepEqual({ n: h.status(10_000).commitsPending, age: h.status(10_000).oldestCommitPendingSecs }, { n: 2, age: 10 });
    t.clear("match=1");
    assert.equal(h.status(10_000).oldestCommitPendingSecs, 6);
  });
});

describe("startWatchdog", () => {
  it("exits with 1 once the loop is stale, and only once", async () => {
    const h = new Health(10);
    const exits: number[] = [];
    const lines: string[] = [];
    startWatchdog(h, (m) => lines.push(m), (c) => exits.push(c), 5);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(exits, [1]);
    assert.match(lines[0], /^FATAL no pass finished/);
  });

  it("does nothing while passes keep finishing", async () => {
    const h = new Health(50);
    const exits: number[] = [];
    const beats = setInterval(() => h.beat(true), 10);
    const t = startWatchdog(h, () => {}, (c) => exits.push(c), 5);
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(beats);
    clearInterval(t);
    assert.deepEqual(exits, []);
  });
});

describe("startHealthServer", () => {
  it("answers /healthz with 200 while alive and 503 when stale", async () => {
    const h = new Health(1000);
    const server = startHealthServer(h, 0, () => {});
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).alive, true);
      (h as unknown as { lastBeat: number }).lastBeat = Date.now() - 5000;
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 503);
      assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
    } finally {
      server.close();
    }
  });
});
