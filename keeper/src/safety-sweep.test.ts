import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadIdl } from "./runtime.ts";
import { Deferred, GRACE_SECS, headOf, memorySweepStore, safetySweep, SLICE_LEN, type Head, type SweepDeps } from "./safety-sweep.ts";

const coder = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {})).coder.accounts;
const fixture = Buffer.from((JSON.parse(readFileSync(new URL("../fixtures/core-layouts.json", import.meta.url), "utf8")) as Record<string, string>).match, "hex");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));

describe("reading a Match head from a sliced scan row", () => {
  const decoded = coder.decode("matchState", fixture);
  const stageOf = (s: object) => Object.keys(s)[0].toLowerCase();

  /** The fixture's Match with fields replaced (shallow copies keep the BN values the coder encodes). */
  const variant = (inner: Record<string, unknown>, terms: Record<string, unknown> = {}) => ({ ...decoded, inner: { ...decoded.inner, ...inner, terms: { ...decoded.inner.terms, ...terms } } });

  it("agrees with the program's own bytes, for every combination of the two optional fields", async () => {
    for (const joined of [false, true]) {
      for (const outside of [false, true]) {
        const m = variant({ b: joined ? decoded.inner.b ?? { ...decoded.inner.a } : null }, { studioOwner: outside ? Array.from(key(7).toBytes()) : null });
        const data = Buffer.concat([Buffer.from(await coder.encode("matchState", m)), Buffer.alloc(40)]);
        const h = headOf(key(1), data.subarray(0, SLICE_LEN));
        assert.ok(h);
        assert.equal(h.stage, stageOf(m.inner.stage));
        assert.equal(h.joined, joined);
        assert.equal(h.deadline, Number(m.inner.deadline.toString()));
        assert.equal(h.openedAt, Number(m.inner.openedAt.toString()));
        assert.equal(h.game.toBase58(), new PublicKey(Uint8Array.from(m.inner.game)).toBase58());
        assert.equal(h.backed, Buffer.compare(Buffer.from(m.inner.a.player), Buffer.from(m.inner.a.funder)) !== 0);
      }
    }
  });

  it("reads a Backer-funded Open Match", async () => {
    const m = variant({ b: null, stage: { open: {} }, run: null, a: { ...decoded.inner.a, funder: Array.from(key(9).toBytes()), player: Array.from(key(3).toBytes()) } });
    const h = headOf(key(1), Buffer.from(await coder.encode("matchState", m)).subarray(0, SLICE_LEN));
    assert.deepEqual([h?.stage, h?.joined, h?.backed], ["open", false, true]);
  });

  it("ignores rows that are not Match accounts", () => {
    assert.equal(headOf(key(1), Buffer.alloc(SLICE_LEN, 1)), null);
  });
});

// ---- the sweep ----------------------------------------------------------------------------------------------------

const T0 = 1_800_000_000;
const head = (n: number, over: Partial<Head> = {}): Head => ({ address: key(n), game: key(200), stage: "active", joined: true, backed: false, openedAt: T0 - 3600, deadline: T0 + 86_400, ...over });

/** A fake chain: `progress[address]` is the Match's state key (null once closed away); sends are recorded. */
function fake(heads: Head[], opts: { committed?: Set<string>; failing?: Set<string>; stuck?: Set<string> } = {}) {
  const sent: string[] = [];
  const progress = new Map<string, string | null>(heads.map((h) => [h.address.toBase58(), `${h.stage}:0:0`]));
  const name = (a: PublicKey) => a.toBase58().slice(0, 4);
  const deps: SweepDeps = {
    scan: async () => heads.filter((h) => progress.get(h.address.toBase58()) !== null),
    committed: async (h) => !!opts.committed?.has(h.address.toBase58()),
    progress: async (a) => progress.get(a.toBase58()) ?? null,
    finalize: async (h) => {
      sent.push(`finalize ${name(h.address)}`);
      if (opts.failing?.has(h.address.toBase58())) throw new Error("boom");
      progress.set(h.address.toBase58(), "settling:0:0");
    },
    finish: async (a) => {
      sent.push(`finish ${name(a)}`);
      if (opts.failing?.has(a.toBase58())) throw new Error("boom");
      if (!opts.stuck?.has(a.toBase58())) progress.set(a.toBase58(), null);
    },
    refund: async (h) => {
      sent.push(`refund ${name(h.address)}`);
      progress.set(h.address.toBase58(), "refunding:0:0");
    },
  };
  return { deps, sent, progress };
}
const run = (deps: SweepDeps, store: ReturnType<typeof memorySweepStore>, now: number, dryRun = false) => safetySweep(deps, store, { now, dryRun });

describe("the safety sweep: a Match whose result is committed", () => {
  it("waits out the grace after first seeing the commit, then finalizes and finishes it", async () => {
    const h = head(1);
    const { deps, sent } = fake([h], { committed: new Set([h.address.toBase58()]) });
    const store = memorySweepStore();
    const first = await run(deps, store, T0);
    assert.deepEqual(sent, []);
    assert.equal(first.candidates[0].action, "wait");
    await run(deps, store, T0 + GRACE_SECS - 1);
    assert.deepEqual(sent, []);
    const third = await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(sent, [`finalize ${h.address.toBase58().slice(0, 4)}`, `finish ${h.address.toBase58().slice(0, 4)}`]);
    assert.equal(third.candidates[0].action, "send");
    assert.deepEqual(store.load().seen, {}, "a finished Match leaves no state");
  });

  it("does nothing for an Active Match with no committed result, and for one younger than the grace", async () => {
    const quiet = head(1);
    const young = head(2, { openedAt: T0 - 60 });
    const { deps, sent } = fake([quiet, young], { committed: new Set([young.address.toBase58()]) });
    const store = memorySweepStore();
    const r = await run(deps, store, T0 + 60);
    assert.deepEqual(sent, []);
    assert.deepEqual(r.candidates.map((c) => c.address.toBase58()), [], "neither is a candidate");
    assert.deepEqual(store.load().seen, {});
  });
});

describe("the safety sweep: a Settling Match not fully paid", () => {
  it("runs its chunks and closes it once it has been Settling for the grace", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent } = fake([h]);
    const store = memorySweepStore();
    await run(deps, store, T0);
    assert.deepEqual(sent, []);
    await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(sent, [`finish ${h.address.toBase58().slice(0, 4)}`]);
  });

  it("skips a Match another actor finished between the scan and the send", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent, progress } = fake([h]);
    const store = memorySweepStore();
    await run(deps, store, T0);
    progress.set(h.address.toBase58(), null);
    const r = await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(sent, []);
    assert.deepEqual(r.candidates, []);
    assert.deepEqual(store.load().seen, {}, "its state is dropped");
  });
});

describe("the safety sweep: a Backer-funded Match nobody joined", () => {
  it("refunds it as soon as its deadline has passed, with no grace", async () => {
    const h = head(1, { stage: "open", joined: false, backed: true, deadline: T0 - 1 });
    const { deps, sent } = fake([h]);
    await run(deps, memorySweepStore(), T0);
    assert.deepEqual(sent, [`refund ${h.address.toBase58().slice(0, 4)}`]);
  });

  it("leaves alone an Open Match before its deadline, one nobody backed, and one somebody joined", async () => {
    const early = head(1, { stage: "open", joined: false, backed: true, deadline: T0 + 5 });
    const plain = head(2, { stage: "open", joined: false, backed: false, deadline: T0 - 1 });
    const { deps, sent } = fake([early, plain]);
    const r = await run(deps, memorySweepStore(), T0);
    assert.deepEqual(sent, []);
    assert.deepEqual(r.candidates, []);
  });
});

describe("the safety sweep: a Match that does not move", () => {
  it("alerts after two sends that left it at the same place, and retries it only hourly", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent } = fake([h], { stuck: new Set([h.address.toBase58()]) });
    const store = memorySweepStore();
    await run(deps, store, T0);
    await run(deps, store, T0 + GRACE_SECS); // first try
    const second = await run(deps, store, T0 + GRACE_SECS + 300); // second try, still at the same place
    assert.equal(sent.length, 2);
    assert.equal(second.alerts.length, 0, "the second send has just gone out; the third sweep judges it");
    const third = await run(deps, store, T0 + GRACE_SECS + 600);
    assert.equal(sent.length, 2, "not retried inside the hour");
    assert.equal(third.alerts.length, 1);
    assert.match(third.alerts[0], /stuck/);
    assert.equal(third.candidates[0].action, "stuck");
    const fourth = await run(deps, store, T0 + GRACE_SECS + 900);
    assert.equal(fourth.alerts.length, 1, "still reported, so the unit keeps failing");
    assert.equal(fourth.newAlerts.length, 0, "but only announced once");
  });

  it("retries an alerted Match after an hour, and clears the alert once it moves", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent, progress } = fake([h], { stuck: new Set([h.address.toBase58()]) });
    const store = memorySweepStore();
    await run(deps, store, T0);
    await run(deps, store, T0 + GRACE_SECS);
    await run(deps, store, T0 + GRACE_SECS + 300);
    await run(deps, store, T0 + GRACE_SECS + 600); // alerted
    const hourLater = await run(deps, store, T0 + GRACE_SECS + 300 + 3600);
    assert.equal(sent.length, 3, "retried so it can recover");
    assert.equal(hourLater.alerts.length, 1, "still stuck until it moves");
    progress.set(h.address.toBase58(), null); // a retry finally closed it
    const after = await run(deps, store, T0 + GRACE_SECS + 300 + 3900);
    assert.deepEqual(after.alerts, []);
  });

  it("does not alert on a Match that moved since the last try (a long Pot needs several sweeps)", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent, progress } = fake([h], { stuck: new Set([h.address.toBase58()]) });
    const store = memorySweepStore();
    await run(deps, store, T0);
    await run(deps, store, T0 + GRACE_SECS);
    progress.set(h.address.toBase58(), "settling:2:5"); // our chunks landed
    await run(deps, store, T0 + GRACE_SECS + 300);
    progress.set(h.address.toBase58(), "settling:4:5");
    const next = await run(deps, store, T0 + GRACE_SECS + 600);
    assert.equal(sent.length, 3, "tried again each time");
    assert.deepEqual(next.alerts, []);
  });

  it("does not call a Match stuck after one transient failure: it is retried on the next sweep", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent } = fake([h], { failing: new Set([h.address.toBase58()]) });
    const store = memorySweepStore();
    await run(deps, store, T0);
    for (let i = 1; i <= 3; i++) {
      const r = await run(deps, store, T0 + GRACE_SECS + 300 * i);
      assert.deepEqual(r.alerts, [], `sweep ${i}`);
    }
    assert.equal(sent.length, 3, "every sweep sent it again");
  });

  it("alerts when the send keeps failing for half an hour", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent } = fake([h], { failing: new Set([h.address.toBase58()]) });
    const store = memorySweepStore();
    await run(deps, store, T0);
    let last = await run(deps, store, T0 + GRACE_SECS);
    for (let i = 1; i <= 7; i++) last = await run(deps, store, T0 + GRACE_SECS + 300 * i);
    assert.equal(last.alerts.length, 1);
    assert.ok(sent.length < 9, "stops hammering once alerted");
  });
});

describe("the safety sweep: a send the spend cap held back", () => {
  it("is not a try: the next sweep sends it instead of calling it stuck", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, sent } = fake([h]);
    let capped = true;
    const finish = deps.finish;
    deps.finish = async (a) => {
      if (capped) throw new Deferred("hourly spend cap reached");
      return finish(a);
    };
    const store = memorySweepStore();
    await run(deps, store, T0);
    const held = await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(held.alerts, []);
    capped = false;
    const later = await run(deps, store, T0 + GRACE_SECS + 300);
    assert.deepEqual(later.alerts, []);
    assert.equal(sent.length, 1);
  });
});

describe("the safety sweep: --dry-run", () => {
  it("lists candidates and what it would do, sends nothing and saves nothing", async () => {
    const stale = head(1, { stage: "settling" });
    const refund = head(2, { stage: "open", joined: false, backed: true, deadline: T0 - 1 });
    const { deps, sent } = fake([stale, refund]);
    const store = memorySweepStore({ seen: { [stale.address.toBase58()]: { since: T0 } } });
    const before = JSON.stringify(store.load());
    const r = await run(deps, store, T0 + GRACE_SECS, true);
    assert.deepEqual(sent, []);
    assert.deepEqual(r.candidates.map((c) => [c.case, c.action]), [["finish", "send"], ["refund", "send"]]);
    assert.deepEqual(r.scanned, { settling: 1, open: 1 });
    assert.equal(JSON.stringify(store.load()), before);
  });
});
