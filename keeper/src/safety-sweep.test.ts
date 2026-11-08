import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadIdl } from "./runtime.ts";
import { decodeCar } from "../../app/src/lib/chain/many-seat.ts";
import { Deferred, GRACE_SECS, carHeadAt, headOf, memorySweepStore, RIDE_TIMEOUT_SECS, safetySweep, SLICE_LEN, type Head, type SweepDeps } from "./safety-sweep.ts";

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

describe("reading a car's head from a sliced scan row", () => {
  // The worked example's car as Railcar's LiteSVM left it before its first chunk.
  const car = Buffer.from((JSON.parse(readFileSync(new URL("../../app/src/lib/chain/many-seat-ahead.worked-example.fixtures.json", import.meta.url), "utf8")) as { cases: { match: string }[] }).cases[0].match, "hex");
  it("reads what the app's car decoder reads", () => {
    const full = decodeCar(key(1), car);
    const h = carHeadAt(key(1), car.subarray(0, SLICE_LEN));
    assert.ok(h?.car);
    assert.deepEqual([h.stage, h.game.toBase58(), h.openedAt, h.deadline], ["settling", full.game.toBase58(), full.openedAt, full.deadlineAbs]);
    assert.deepEqual(h.car, { seated: full.seated, minSeats: full.minSeats, firstMinAt: full.firstMinAt, departedAt: full.departedAt, refundAfter: full.refundAfter });
  });
  it("is not a Match head, and a Match row is not a car", () => {
    assert.equal(headOf(key(1), car.subarray(0, SLICE_LEN)), null);
    assert.equal(carHeadAt(key(1), fixture.subarray(0, SLICE_LEN)), null);
  });
});

// ---- the sweep ----------------------------------------------------------------------------------------------------

const T0 = 1_800_000_000;
const head = (n: number, over: Partial<Head> = {}): Head => ({ address: key(n), game: key(200), stage: "active", joined: true, backed: false, openedAt: T0 - 3600, deadline: T0 + 86_400, ...over });

/** A fake chain: `progress[address]` is the Match's state key (null once closed away); sends are recorded. */
function fake(heads: Head[], opts: { committed?: Set<string>; failing?: Set<string>; stuck?: Set<string>; waiting?: Map<string, "untabled" | "unbegun"> } = {}) {
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
    waiting: async (h) => opts.waiting?.get(h.address.toBase58()) ?? null,
    refundUntabled: async (h) => {
      sent.push(`refundUntabled ${name(h.address)}`);
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

  it("refunds an Open Match nobody backed too, as the old loop did", async () => {
    const plain = head(2, { stage: "open", joined: false, backed: false, deadline: T0 - 1 });
    const { deps, sent } = fake([plain]);
    await run(deps, memorySweepStore(), T0);
    assert.deepEqual(sent, [`refund ${plain.address.toBase58().slice(0, 4)}`]);
  });

  it("leaves alone an Open Match before its deadline", async () => {
    const early = head(1, { stage: "open", joined: false, backed: true, deadline: T0 + 5 });
    const { deps, sent } = fake([early]);
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

// ---- candidates from the database ---------------------------------------------------------------------------------

/** The fake chain plus a database: `db` lists the Matches it knows; `scans` and `reads` count the chain calls. */
function withDb(heads: Head[], db: Head[], opts: { committed?: Set<string>; dbFails?: boolean; waiting?: Map<string, "untabled" | "unbegun"> } = {}) {
  const base = fake(heads, { committed: opts.committed, waiting: opts.waiting });
  const calls = { committed: 0, scans: 0, reads: [] as string[][], gone: [] as string[] };
  const deps: SweepDeps = {
    ...base.deps,
    committed: async (h) => {
      calls.committed++;
      return base.deps.committed(h);
    },
    scan: async () => {
      calls.scans++;
      return base.deps.scan();
    },
    dbMatches: async () => {
      if (opts.dbFails) throw new Error("database down");
      return db.map((h) => h.address);
    },
    readHeads: async (addresses) => {
      calls.reads.push(addresses.map((a) => a.toBase58()));
      const live = (await base.deps.scan()).filter((h) => addresses.some((a) => a.equals(h.address)));
      return { heads: live, gone: addresses.filter((a) => !live.some((h) => h.address.equals(a))) };
    },
    markGone: async (addresses) => void calls.gone.push(...addresses.map((a) => a.toBase58())),
  };
  return { ...base, deps, calls };
}

describe("the safety sweep: candidates from the database", () => {
  it("a 5-minute run reads only the database's Matches by address and scans nothing", async () => {
    const known = head(1, { stage: "settling" });
    const unknown = head(2, { stage: "settling" });
    const { deps, calls, sent } = withDb([known, unknown], [known]);
    const r = await run(deps, memorySweepStore({ seen: {}, fullScanAt: T0 - 60 }), T0);
    assert.equal(r.mode, "db");
    assert.equal(calls.scans, 0);
    assert.deepEqual(calls.reads, [[known.address.toBase58()]]);
    assert.deepEqual(r.candidates.map((c) => c.address.toBase58()), [known.address.toBase58()]);
    assert.deepEqual(sent, []);
  });

  it("tells the database about a Match whose account is gone, and keeps no state for it", async () => {
    const gone = head(1);
    const { deps, calls, progress } = withDb([gone], [gone]);
    progress.set(gone.address.toBase58(), null);
    const store = memorySweepStore({ seen: { [gone.address.toBase58()]: { since: T0 - 900 } }, fullScanAt: T0 - 60 });
    await run(deps, store, T0);
    assert.deepEqual(calls.gone, [gone.address.toBase58()]);
    assert.deepEqual(store.load().seen, {});
  });

  it("the hourly run scans the chain, finishes what it finds, and alerts on a Match the database missed", async () => {
    const known = head(1, { stage: "settling" });
    const missed = head(2, { stage: "settling" });
    const { deps, calls } = withDb([known, missed], [known]);
    const store = memorySweepStore({ seen: {}, fullScanAt: T0 - 3600 });
    const r = await run(deps, store, T0);
    assert.equal(r.mode, "full");
    assert.equal(calls.scans, 1);
    assert.deepEqual(r.dbMisses, [missed.address.toBase58()]);
    assert.equal(r.candidates.length, 2);
    assert.equal(store.load().fullScanAt, T0);
  });

  it("a Match with nothing to do is not a miss", async () => {
    const quiet = head(1, { openedAt: T0 - 30 });
    const { deps } = withDb([quiet], []);
    const r = await run(deps, memorySweepStore(), T0);
    assert.deepEqual(r.dbMisses, []);
  });

  it("a Match the webhook never delivered is finished within 1 h 15 min of 5-minute runs", async () => {
    const missed = head(1, { stage: "settling" });
    const { deps, sent, progress } = withDb([missed], []);
    const store = memorySweepStore();
    let sentAt: number | null = null;
    // The last hourly scan was 10 minutes before the Match settled; ticks follow every 5 minutes.
    store.save({ seen: {}, fullScanAt: T0 - 600 });
    for (let t = T0; t <= T0 + 75 * 60 && sentAt === null; t += 300) {
      await run(deps, store, t);
      if (sent.length) sentAt = t - T0;
    }
    assert.ok(sentAt !== null && sentAt <= 75 * 60, `sent at ${sentAt}`);
    assert.ok(sentAt >= 60 * 60 - 600, "not before the hourly scan found it");
    assert.equal(progress.get(missed.address.toBase58()), null);
  });

  it("falls back to the full scan when the database cannot be read", async () => {
    const h = head(1, { stage: "settling" });
    const { deps, calls } = withDb([h], [], { dbFails: true });
    const r = await run(deps, memorySweepStore({ seen: {}, fullScanAt: T0 - 60 }), T0);
    assert.equal(r.mode, "fallback");
    assert.equal(calls.scans, 1);
    assert.equal(r.candidates.length, 1);
    assert.deepEqual(r.dbMisses, []);
  });

  it("runs the full scan every time when deps have no database", async () => {
    const { deps } = fake([head(1, { stage: "settling" })]);
    const r = await run(deps, memorySweepStore({ seen: {}, fullScanAt: T0 - 60 }), T0);
    assert.equal(r.mode, "full");
  });

  it("dry-run saves nothing and tells the database nothing", async () => {
    const gone = head(1);
    const { deps, calls, progress } = withDb([gone], [gone]);
    progress.set(gone.address.toBase58(), null);
    const store = memorySweepStore({ seen: {}, fullScanAt: T0 - 3600 });
    await run(deps, store, T0, true);
    assert.deepEqual(calls.gone, []);
    assert.equal(store.load().fullScanAt, T0 - 3600);
  });
});

describe("the safety sweep: an Active Match with no result backs off", () => {
  const zombie = () => head(1, { openedAt: T0 - 3600 });

  it("is asked about at 5, 15, 30 minutes, then left to the hourly scan", async () => {
    const z = zombie();
    const { deps, calls } = withDb([z], [z]);
    const store = memorySweepStore({ seen: {}, fullScanAt: T0 });
    const checkedAt: number[] = [];
    for (let t = T0; t < T0 + 2 * 3600; t += 300) {
      const before = calls.committed;
      await run(deps, store, t);
      if (calls.committed > before) checkedAt.push((t - T0) / 60);
    }
    // 0, +5, +20 (15 later), +50 (30 later); the hourly scan at 60 asks again, then the schedule restarts from there.
    assert.deepEqual(checkedAt.slice(0, 4), [0, 5, 20, 50]);
    assert.ok(checkedAt.includes(60), "the hourly scan asks regardless");
    assert.ok(calls.committed <= 8, `asked ${calls.committed} times in 2 hours`);
  });

  it("finds a result that commits during the back-off by the next hourly scan, and finishes it", async () => {
    const z = zombie();
    const committed = new Set<string>();
    const { deps, sent } = withDb([z], [z], { committed });
    const store = memorySweepStore({ seen: {}, fullScanAt: T0 });
    for (let t = T0; t <= T0 + 3 * 3600 && !sent.length; t += 300) {
      if (t === T0 + 3300) committed.add(z.address.toBase58());
      await run(deps, store, t);
    }
    assert.equal(sent.length, 2, "finalize and finish went out");
  });

  it("asks again at once when the Match changes (a new deadline)", async () => {
    const z = zombie();
    const { deps, calls } = withDb([z], [z]);
    const store = memorySweepStore({ seen: {}, fullScanAt: T0 });
    await run(deps, store, T0);
    await run(deps, store, T0 + 300);
    assert.equal(calls.committed, 2);
    z.deadline += 600;
    await run(deps, store, T0 + 360);
    assert.equal(calls.committed, 3);
  });

  it("does not ask a Match the sweep has no reason to look at", async () => {
    const young = head(1, { openedAt: T0 - 30 });
    const { deps, calls } = withDb([young], [young]);
    await run(deps, memorySweepStore({ seen: {}, fullScanAt: T0 }), T0);
    assert.equal(calls.committed, 0);
  });
});

describe("the safety sweep: an Active Match past its deadline with no result", () => {
  const late = (n = 1) => head(n, { openedAt: T0 - 7200, deadline: T0 - 1 });
  const short = (h: Head) => h.address.toBase58().slice(0, 4);

  it("is refunded at once, with no grace and no back-off", async () => {
    const z = late();
    const { deps, sent } = withDb([z], [z]);
    const store = memorySweepStore({ seen: {}, fullScanAt: T0, quiet: { [z.address.toBase58()]: { key: `active:${z.deadline}`, asked: 3, next: T0 + 3600 } } });
    const r = await run(deps, store, T0);
    assert.deepEqual(sent, [`refund ${short(z)}`]);
    assert.equal(r.candidates[0].case, "refund");
  });

  it("is not refunded before its deadline", async () => {
    const z = head(1, { openedAt: T0 - 7200, deadline: T0 + 1 });
    const { deps, sent } = fake([z]);
    await run(deps, memorySweepStore(), T0);
    assert.deepEqual(sent, []);
  });

  it("is finished, not refunded, when the Table holds its result", async () => {
    const z = late();
    const { deps, sent } = fake([z], { committed: new Set([z.address.toBase58()]) });
    const store = memorySweepStore();
    await run(deps, store, T0);
    assert.deepEqual(sent, [], "waits out the finalize grace");
    await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(sent, [`finalize ${short(z)}`, `finish ${short(z)}`]);
  });

  it("is finished, not refunded, when the result commits after the first look and before the send", async () => {
    const z = late();
    const base = fake([z]);
    let reads = 0;
    const deps: SweepDeps = { ...base.deps, committed: async () => ++reads > 1 };
    const store = memorySweepStore();
    const r = await run(deps, store, T0);
    assert.equal(reads, 2, "read again just before the send");
    assert.deepEqual(base.sent, []);
    assert.equal(r.candidates[0].case, "finalize");
    await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(base.sent, [`finalize ${short(z)}`, `finish ${short(z)}`]);
  });

  it("is not refunded when the Table cannot be read, and the rest of the run goes on", async () => {
    const bad = late(1);
    const other = head(2, { stage: "settling" });
    const base = fake([bad, other]);
    const deps: SweepDeps = { ...base.deps, committed: async () => { throw new Error("rpc down"); } };
    const store = memorySweepStore();
    await run(deps, store, T0);
    await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(base.sent, [`finish ${short(other)}`]);
  });

  it("dry-run reports the refund it would send and sends nothing", async () => {
    const z = late();
    const { deps, sent } = fake([z]);
    const r = await run(deps, memorySweepStore(), T0, true);
    assert.deepEqual(sent, []);
    assert.deepEqual([r.candidates[0].case, r.candidates[0].action], ["refund", "send"]);
  });
});

// ---- many-seat cars (Railcar) -------------------------------------------------------------------------------------

describe("the safety sweep: a Railcar ride whose pages are all gone", () => {
  const car = (n: number, over: Partial<Head> = {}, facts: Partial<NonNullable<Head["car"]>> = {}): Head => ({
    ...head(n, { stage: "active", openedAt: T0 - 600, deadline: T0 + 7 * 86_400 }),
    car: { seated: 5, minSeats: 5, firstMinAt: T0 - 30, departedAt: T0, refundAfter: T0 + 86_400, ...facts },
    ...over,
  });

  /**
   * A car on a fake chain. Its ride: the draw is in at T0 and its Impact at T0 + 120 s. A ride step before the Impact defers;
   * after it, the first step is the signal that ends the ride, the second `finalize` (core then settles); `finish` closes it.
   */
  function rideChain(h: Head) {
    const id = h.address.toBase58();
    const sent: string[] = [];
    let state: "riding" | "over" | "settling" | "gone" = "riding";
    let now = 0;
    const deps: SweepDeps = {
      scan: async () => (state === "gone" ? [] : [state === "settling" ? { ...h, stage: "settling" as const } : h]),
      committed: async () => false,
      progress: async () => (state === "gone" ? null : `car:${state}`),
      finalize: async () => assert.fail("a car is never finalized as a Match"),
      finish: async (a) => {
        assert.equal(a.toBase58(), id);
        sent.push("finish");
        state = "gone";
      },
      refund: async () => assert.fail("the sweep refunds a car through its ride step"),
      ride: async () => {
        if (now < T0 + 120) throw new Deferred("the ride has not reached its Impact yet");
        if (state === "riding") {
          sent.push("signal");
          state = "over";
        } else {
          sent.push("finalize");
          state = "settling";
        }
      },
    };
    return { deps, sent, at: (t: number) => (now = t) };
  }

  it("leaves the ride to its pages until RIDE_TIMEOUT_SECS after departure, then finishes it", async () => {
    const h = car(1);
    const { deps, sent, at } = rideChain(h);
    const store = memorySweepStore();
    const tick = async (t: number) => {
      at(t);
      return run(deps, store, t);
    };
    const early = await tick(T0 + RIDE_TIMEOUT_SECS - 1);
    assert.deepEqual([sent, early.candidates.length], [[], 0], "the ride is the pages' until its timeout");
    // every five minutes: the signal that applies the Impact, then finalize, then core's chunks and closes
    const r1 = await tick(T0 + RIDE_TIMEOUT_SECS);
    assert.deepEqual([r1.candidates[0].case, r1.candidates[0].action], ["ride", "send"]);
    await tick(T0 + RIDE_TIMEOUT_SECS + 300);
    assert.deepEqual(sent, ["signal", "finalize"]);
    await tick(T0 + RIDE_TIMEOUT_SECS + 600);
    await tick(T0 + RIDE_TIMEOUT_SECS + 900);
    assert.deepEqual(sent, ["signal", "finalize", "finish"]);
    const last = await tick(T0 + RIDE_TIMEOUT_SECS + 1200);
    assert.deepEqual([last.candidates.length, last.alerts], [0, []]);
  });

  it("does not count a ride step that found nothing due as a try, so a long ride raises no alert", async () => {
    const h = car(2, {}, { departedAt: T0 - 2 * RIDE_TIMEOUT_SECS });
    const { deps, sent, at } = rideChain(h);
    const store = memorySweepStore();
    for (let k = 0; k < 4; k++) {
      // a candidate every run, but its Impact (T0 + 120 s here) stays ahead of each
      at(T0 - 600 + k * 120);
      const r = await run(deps, store, T0 - 600 + k * 120);
      assert.deepEqual([r.candidates[0]?.case, r.candidates[0]?.action, r.alerts], ["ride", "send", []]);
    }
    assert.deepEqual(sent, []);
  });

  it("sends a car that held its minimum and never left on its way, and leaves a short car alone", async () => {
    const due = car(3, { stage: "open" }, { departedAt: 0, firstMinAt: T0 - RIDE_TIMEOUT_SECS });
    const short = car(4, { stage: "open" }, { departedAt: 0, seated: 4, firstMinAt: 0 });
    const asked: string[] = [];
    const { deps } = fake([due, short]);
    deps.ride = async (h) => void asked.push(h.address.toBase58());
    await run(deps, memorySweepStore(), T0);
    assert.deepEqual(asked, [due.address.toBase58()]);
  });

  it("steps a Boarding car off once its boarding has ended, short or not: nobody can join or depart it any more", async () => {
    // Four aboard waiting for a fifth, at the car's deadline less core's one-hour boarding margin.
    const deadline = T0 + 3_600;
    const short = car(8, { stage: "open", deadline }, { departedAt: 0, seated: 4, firstMinAt: 0 });
    const asked: string[] = [];
    const { deps } = fake([short]);
    deps.ride = async (h) => void asked.push(h.address.toBase58());
    await run(deps, memorySweepStore(), T0 - 1);
    assert.deepEqual(asked, [], "boarding still open: the car waits for its fifth Player");
    await run(deps, memorySweepStore(), T0);
    assert.deepEqual(asked, [short.address.toBase58()]);
  });

  it("finishes a car core is settling or has paid after the usual grace, through the same finisher", async () => {
    const settling = car(5, { stage: "settling" });
    const paid = car(6, { stage: "closed" });
    const { deps, sent } = fake([settling, paid]);
    const store = memorySweepStore();
    await run(deps, store, T0);
    assert.deepEqual(sent, []);
    await run(deps, store, T0 + GRACE_SECS);
    assert.deepEqual(sent.sort(), [`finish ${settling.address.toBase58().slice(0, 4)}`, `finish ${paid.address.toBase58().slice(0, 4)}`].sort());
  });

  it("is no database miss when only the full scan finds it", async () => {
    const h = car(7, { stage: "settling" });
    const { deps } = fake([h]);
    deps.dbMatches = async () => [];
    deps.readHeads = async () => ({ heads: [], gone: [] });
    deps.markGone = async () => {};
    const r = await safetySweep(deps, memorySweepStore(), { now: T0, full: true });
    assert.deepEqual(r.dbMisses, []);
  });
});

describe("the safety sweep: a joined Match that never got a table (ticket 58)", () => {
  // Opened 20 minutes ago, joined 6 minutes ago: no Assignment, and its Game's table wait is over.
  const untabled = () => head(1, { openedAt: T0 - 1200, deadline: T0 - 360 + 3600 });
  const tag = (h: Head) => h.address.toBase58().slice(0, 4);

  it("sends the Game's refund_untabled at once, then the chunks and close", async () => {
    const h = untabled();
    const { deps, sent } = fake([h], { waiting: new Map([[h.address.toBase58(), "untabled"]]) });
    const r = await run(deps, memorySweepStore(), T0);
    assert.deepEqual(sent, [`refundUntabled ${tag(h)}`, `finish ${tag(h)}`]);
    assert.deepEqual(r.candidates.map((c) => [c.case, c.action]), [["untabled", "send"]]);
  });

  it("checks again on the next run when the first refund did not land", async () => {
    const h = untabled();
    const { deps, sent, progress } = fake([h], { waiting: new Map([[h.address.toBase58(), "untabled"]]) });
    deps.refundUntabled = async (x) => void sent.push(`refundUntabled ${tag(x)}`);
    deps.finish = async (a) => void sent.push(`finish ${tag(head(0, { address: a }))}`);
    const store = memorySweepStore();
    await run(deps, store, T0);
    progress.set(h.address.toBase58(), "active:0:0");
    await run(deps, store, T0 + 300);
    assert.deepEqual(sent.filter((x) => x.startsWith("refundUntabled")).length, 2, "the case is the untabled refund again, not a finalize");
    assert.ok(!sent.some((x) => x.startsWith("finalize")));
  });

  it("does nothing while the table wait still runs", async () => {
    const h = untabled();
    const { deps, sent } = fake([h]);
    const r = await run(deps, memorySweepStore(), T0);
    assert.deepEqual(sent, []);
    assert.deepEqual(r.candidates, []);
  });
});

describe("the safety sweep: an assigned Match that never began (ticket 59)", () => {
  it("is asked about every 5 minutes, not backed off, and is finalized soon after its table moves on", async () => {
    const z = head(1, { openedAt: T0 - 3600 });
    const committed = new Set<string>();
    const { deps, calls, sent } = withDb([z], [z], { committed, waiting: new Map([[z.address.toBase58(), "unbegun"]]) });
    const store = memorySweepStore({ seen: {}, fullScanAt: T0 });
    const checkedAt: number[] = [];
    let sentAt = -1;
    for (let t = T0; t <= T0 + 2 * 3600 && sentAt < 0; t += 300) {
      // The table's next Matches run: base holds a later epoch from 40 minutes on.
      if (t === T0 + 2400) committed.add(z.address.toBase58());
      const before = calls.committed;
      await run(deps, store, t);
      if (calls.committed > before) checkedAt.push((t - T0) / 60);
      if (sent.length && sentAt < 0) sentAt = (t - T0) / 60;
    }
    assert.deepEqual(checkedAt.slice(0, 5), [0, 5, 10, 15, 20]);
    assert.ok(sentAt >= 0 && sentAt <= 40 + GRACE_SECS / 60, `finalized at +${sentAt} min`);
  });
});
