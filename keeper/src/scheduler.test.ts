import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { clearRaised, raisedConditions } from "./alerts.ts";
import { PHASE } from "../../app/src/games/trading-duel/chain.ts";
import { tableStep, type TableFacts } from "./tables.ts";
import {
  assignmentClosable,
  dueForRefund,
  gameSettings,
  isAvailable,
  newGameState,
  planAssignments,
  planGrowth,
  planSkips,
  quiet,
  runGame,
  schedulerSettings,
  stuckReason,
  TABLE_WAIT_SECS,
  untabledSince,
  type GameAdapter,
  type GameSettings,
  type SetupStep,
  type TableRow,
  type TableView,
  type UpkeepStep,
} from "./scheduler.ts";
import { tablesJob } from "./scheduler-games.ts";

const PROGRAM = new PublicKey("CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const NOW = 100_000;
const free = { state: 0, tesoroMatch: key(0), epoch: 0, at: 0 };
const fullRing = (state = 1) => Array.from({ length: 8 }, (_, i) => ({ state, tesoroMatch: key(i + 1), epoch: 0, at: NOW }));

const view = (index: number, over: Partial<TableView> = {}): TableView => ({
  index,
  epoch: 3,
  coarse: "idle",
  seatsCreated: true,
  seatsOpen: false,
  dirty: false,
  overAt: 0,
  tesoroMatch: key(0),
  ring: [free, free],
  raw: null,
  ...over,
});
const row = (index: number, base: TableRow["base"] = "delegated", over: Partial<TableView> | null = {}): TableRow => ({ index, base, view: over === null ? null : view(index, over) });

describe("settings", () => {
  it("defaults the caps (Block Burst 50 on devnet) and reads the environment", () => {
    assert.equal(gameSettings("block-burst", "BURST", {}).cap, 50);
    assert.equal(gameSettings("holdem", "HOLDEM", {}).cap, 20);
    const s = gameSettings("vanguard", "VANGUARD", { KEEPER_VANGUARD_TABLE_CAP: "7", KEEPER_VANGUARD_TABLE_SPARE: "2", KEEPER_VANGUARD_FUEL: "3", KEEPER_VANGUARD_SPONSOR_INIT: "1000" });
    assert.deepEqual([s.cap, s.spare, s.fuel, s.sponsorInit], [7, 2, 3, 1000n]);
    assert.equal(s.sponsorFloor, 20_000_000);
    assert.equal(schedulerSettings({}).tableWaitSecs, 300);
    assert.equal(schedulerSettings({ KEEPER_TABLE_WAIT_SECS: "60" }).tableWaitSecs, 60);
  });
});

describe("which tables can take a Match", () => {
  it("needs a delegated, seated, Idle table with a free ring slot", () => {
    assert.ok(isAvailable(row(0), [], NOW));
    assert.ok(!isAvailable(row(0, "program"), [], NOW));
    assert.ok(!isAvailable(row(0, "delegated", null), [], NOW));
    assert.ok(!isAvailable(row(0, "delegated", { coarse: "match" }), [], NOW));
    assert.ok(!isAvailable(row(0, "delegated", { coarse: "over" }), [], NOW));
    assert.ok(!isAvailable(row(0, "delegated", { seatsCreated: false }), [], NOW));
    assert.ok(!isAvailable(row(0, "delegated", { ring: fullRing() }), [], NOW));
  });

  it("holds a table for an Assignment inside its start window only, and only at the table's own epoch", () => {
    const r = row(2);
    assert.ok(!isAvailable(r, [{ index: 2, epoch: 3, startDeadline: NOW }], NOW), "window still open");
    assert.ok(isAvailable(r, [{ index: 2, epoch: 3, startDeadline: NOW - 1 }], NOW), "window closed without the Match beginning: the table is free again");
    assert.ok(isAvailable(r, [{ index: 2, epoch: 2, startDeadline: NOW + 999 }], NOW), "an Assignment for an older epoch is spent");
    assert.ok(isAvailable(r, [{ index: 5, epoch: 3, startDeadline: NOW + 999 }], NOW), "another table's Assignment");
  });

  it("gives the oldest Match the lowest free table, and no more Matches than tables", () => {
    const rows = [row(0, "delegated", { coarse: "match" }), row(1), row(2)];
    const waiting = [
      { address: key(11), openedAt: 300 },
      { address: key(12), openedAt: 100 },
      { address: key(13), openedAt: 200 },
    ];
    const plan = planAssignments(rows, waiting, [], NOW);
    assert.deepEqual(plan.map((p) => [p.match.address.toBase58(), p.row.index]), [[key(12).toBase58(), 1], [key(13).toBase58(), 2]]);
  });
});

describe("growing the tables", () => {
  const base = { promised: [], waiting: 0, cap: 4, maxTables: 8, spare: 1, min: 1, createPerPass: 2, preSeated: true, now: NOW };
  const missing = (n: number, from = 0) => Array.from({ length: n }, (_, i) => row(from + i, "missing", null));

  it("keeps the minimum and one spare table when nothing waits", () => {
    const g = planGrowth({ ...base, rows: missing(8) });
    assert.deepEqual(g.steps, [{ do: "create_table", index: 0 }]);
    assert.equal(g.capReached, false);
  });

  it("makes tables for waiting Matches, at most createPerPass at a time and never past the cap", () => {
    assert.equal(planGrowth({ ...base, rows: missing(8), waiting: 5 }).steps.length, 2);
    const g = planGrowth({ ...base, rows: [row(0), row(1, "delegated", { coarse: "match" }), row(2, "delegated", { coarse: "match" }), row(3, "delegated", { coarse: "match" }), ...missing(4, 4)], waiting: 3 });
    assert.deepEqual(g.steps, [], "four tables exist, the cap is four");
    assert.equal(g.capReached, true);
  });

  it("counts tables on their way against the deficit and finishes their setup first", () => {
    const g = planGrowth({ ...base, spare: 0, rows: [row(0, "program", null), row(1, "delegated", { seatsCreated: false }), ...missing(6, 2)], waiting: 2 });
    assert.deepEqual(g.steps, [{ do: "delegate_table", index: 0 }, { do: "init_seats", index: 1 }]);
    assert.equal(g.settingUp, 2);
  });

  it("does not seat a Game without private seats", () => {
    const g = planGrowth({ ...base, preSeated: false, spare: 0, min: 0, rows: [row(0, "delegated", { seatsCreated: false })] });
    assert.deepEqual(g.steps, []);
  });

  it("does not raise the cap alarm while ready tables cover the waiting Matches", () => {
    const g = planGrowth({ ...base, cap: 2, rows: [row(0), row(1)], waiting: 2 });
    assert.equal(g.capReached, false);
  });
});

describe("stuck tables", () => {
  const s = { stuckOverSecs: 1800, unsettledSecs: 12 * 3600 };
  it("flags a table Over too long and a result nobody settled", () => {
    assert.equal(stuckReason(view(0, { coarse: "over", overAt: NOW - 100 }), NOW, s), null);
    assert.match(stuckReason(view(0, { coarse: "over", overAt: NOW - 1900 }), NOW, s)!, /Over for 32 min/);
    assert.match(stuckReason(view(0, { ring: [{ ...free, state: 2, at: NOW - 13 * 3600 }] }), NOW, s)!, /unsettled for 13 h/);
    assert.equal(stuckReason(view(0, { ring: [{ ...free, state: 2, at: NOW - 3600 }] }), NOW, s), null);
  });
  it("knows what an Assignment may be closed on", () => {
    assert.ok(assignmentClosable(true, true));
    assert.ok(assignmentClosable(false, false));
    assert.ok(!assignmentClosable(true, false));
  });
  it("leaves an Idle table with an empty ring alone", () => {
    assert.ok(quiet(view(0)));
    assert.ok(!quiet(view(0, { dirty: true })));
    assert.ok(!quiet(view(0, { ring: [{ ...free, state: 2 }] })));
    assert.ok(!quiet(view(0, { coarse: "match" })));
  });
});

// ---- the loop, on a fake Game ------------------------------------------------------------------------------

interface FakeTable {
  base: TableRow["base"];
  view: TableView | null;
  facts?: Partial<TableFacts>;
}

class Fake {
  calls: string[] = [];
  tables = new Map<number, FakeTable>();
  sponsor: TableRow["base"] = "delegated";
  fuel: TableRow["base"] = "delegated";
  sponsorBalance: number | null = 50_000_000;
  refillFails = false;
  refundFails = false;
  operator = Keypair.generate().publicKey;
  maxTables = 8;
  assignments = new Map<string, { generation: number; index: number; epoch: number; startDeadline: number } | null | undefined>();
  assignmentAccounts: PublicKey[] = [];

  addr = (g: number, i: number) => key(100 + i);
  sponsorAddr = key(90);
  fuelAddr = key(91);

  adapter(preSeated = true): GameAdapter {
    const me = this;
    return {
      id: "trading-duel",
      label: "fake",
      env: "FAKE",
      programId: PROGRAM,
      preSeated,
      config: async () => ({ generation: 1, maxTables: me.maxTables, operator: me.operator }),
      tableAddress: me.addr,
      sponsorAddress: () => me.sponsorAddr,
      fuelAddress: () => me.fuelAddr,
      read: async (_c, ref) => me.tables.get(ref.index)?.view ?? null,
      step: async (_c, v): Promise<UpkeepStep> => {
        const f: TableFacts = { phase: PHASE.over, seatsOpen: v.seatsOpen, dirty: v.dirty, sinceOver: NOW - v.overAt, doneSlots: [], matchFrozen: false, recommit: false, ...me.tables.get(v.index)?.facts };
        if (v.coarse === "match") f.phase = PHASE.live;
        if (v.coarse === "idle") f.phase = PHASE.idle;
        return tableStep(f);
      },
      commit: async (_c, r) => me.log(`commit ${r.index}`),
      seats: async (_c, r) => me.log(`seats ${r.index}`),
      reset: async (_c, r) => me.log(`reset ${r.index}`),
      release: async (_c, r, _v, slot) => me.log(`release ${r.index}:${slot}`),
      void: async (_c, r) => me.log(`void ${r.index}`),
      endState: async (_c, _r, v) => ({ tesoroMatch: v.tesoroMatch, epoch: v.epoch, fn: () => null, table: null }),
      assignmentOf: async (_c, m) => {
        const a = me.assignments.get(m.toBase58());
        if (a === undefined && !me.assignments.has(m.toBase58())) return null;
        if (a === undefined) throw new Error("unreadable");
        return a;
      },
      assign: async (_c, m, _i, pick) => me.log(`assign ${m.toBase58().slice(0, 4)}->${pick.index}@${pick.epoch}`),
      setup: async (_c, step: SetupStep, ref) => me.log(`setup ${step.do}${"index" in step ? " " + step.index : ""}${"n" in step ? " " + step.n : ""} ${ref.generation}`),
      sponsorBalance: async () => me.sponsorBalance,
      refill: async () => {
        if (me.refillFails) throw new Error("fuel empty");
        return me.log("refill");
      },
      refundUntabled: async (_c, m) => {
        if (me.refundFails) throw new Error("refused");
        return me.log(`refund_untabled ${m.toBase58().slice(0, 4)}`);
      },
      skip: async (_c, m) => me.log(`skip ${m.toBase58().slice(0, 4)}`),
      assignmentMatches: async () => me.assignmentAccounts,
      closeAssignment: async (_c, m) => me.log(`close_assignment ${m.toBase58().slice(0, 4)}`),
    };
  }
  log(s: string) {
    this.calls.push(s);
    return "sig";
  }
}

const owner = (b: TableRow["base"]) => (b === "missing" ? null : { owner: b === "program" ? PROGRAM : b === "delegated" ? DELEGATION_PROGRAM_ID : key(77) });

function ctxOf(f: Fake, over: { dryRun?: boolean; now?: number; accounts?: Map<string, unknown> } = {}): Ctx {
  const accounts = over.accounts ?? new Map();
  const infoOf = (k: PublicKey) => {
    if (k.equals(f.sponsorAddr)) return owner(f.sponsor);
    if (k.equals(f.fuelAddr)) return owner(f.fuel);
    for (const [i, t] of f.tables) if (f.addr(1, i).equals(k)) return owner(t.base);
    return (accounts.get(k.toBase58()) as object | undefined) ?? null;
  };
  const payer = Keypair.generate();
  f.operator = payer.publicKey;
  return {
    settings: { dryRun: !!over.dryRun },
    budget: new Budget(1e15),
    payer,
    now: over.now ?? NOW,
    conn: {
      getBalance: async () => 1e9,
      getAccountInfo: async (k: PublicKey) => infoOf(k),
      getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(infoOf),
    },
    core: { coder: { accounts: { decode: () => ({}) } } },
  } as unknown as Ctx;
}

const SET: GameSettings = { cap: 4, spare: 1, min: 1, fuel: 0, fuelAmount: 50_000_000n, sponsorFloor: 20_000_000, sponsorInit: 0n, fuelInit: 0n };
const STILL: GameSettings = { ...SET, spare: 0, min: 0 };
const SCHED = { ...schedulerSettings({}), cleanupSecs: 1e9 };
const gateOk = async () => true;
const keys = () => raisedConditions().map((c) => c.key);
const withTable = (f: Fake, i: number, v: Partial<TableView>, facts?: Partial<TableFacts>) => f.tables.set(i, { base: "delegated", view: view(i, v), facts });
const matchOf = (n: number, over: Record<string, unknown> = {}) => ({
  address: key(n),
  stage: "active",
  inner: { game: Array.from(PROGRAM.toBytes()), meta: { asset: 0 }, b: {}, deadline: { toString: () => String(NOW + 3600) }, openedAt: { toString: () => String(NOW - 100 * (20 - n)) }, id: { opener: Array.from(key(1).toBytes()), n: { toString: () => String(n) } }, ...over },
});

describe("table upkeep, one case per branch", () => {
  beforeEach(() => raisedConditions().forEach((c) => clearRaised(c.key)));
  const upkeep = async (f: Fake, gate = gateOk, ctx = ctxOf(f)) => runGame(ctx, f.adapter(), STILL, [], newGameState(), { gate, settings: SCHED });

  it("commits a result that is not on base yet", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", dirty: true, overAt: NOW - 5 });
    await upkeep(f);
    assert.deepEqual(f.calls, ["commit 0"]);
  });

  it("closes the seats, then waits out the delay, then resets", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", seatsOpen: true, overAt: NOW - 5 });
    withTable(f, 1, { coarse: "over", overAt: NOW - 29 });
    withTable(f, 2, { coarse: "over", overAt: NOW - 31 });
    await upkeep(f);
    assert.deepEqual(f.calls, ["seats 0", "reset 2"]);
  });

  it("frees a ring slot once tesoro_core's receipt is old enough, ahead of anything else", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "match", ring: [{ ...free, state: 2, tesoroMatch: key(9), at: NOW }] }, { doneSlots: [{ index: 0, match: key(9).toBase58(), receiptOld: true }] });
    await upkeep(f);
    assert.deepEqual(f.calls, ["release 0:0"]);
  });

  it("gives up a table whose Match tesoro_core already refunded", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "match" }, { matchFrozen: true });
    await upkeep(f);
    assert.deepEqual(f.calls, ["void 0"]);
  });

  it("repeats a commit that probably got lost", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "match", ring: [{ ...free, state: 2, at: NOW - 500 }] }, { recommit: true });
    const st = newGameState();
    await runGame(ctxOf(f), f.adapter(), STILL, [], st, { gate: gateOk, settings: SCHED });
    assert.deepEqual(f.calls, ["commit 0"]);
    assert.equal(st.lastRecommit.get("table=fake/1/0"), NOW, "the keeper's own backoff clock starts");
  });

  it("does not touch a running table or an Idle one", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "match" });
    withTable(f, 1, {});
    await upkeep(f);
    assert.deepEqual(f.calls, []);
  });

  it("holds the reset until the end state is stored, and resets once it is", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", overAt: NOW - 100 });
    await upkeep(f, async () => false);
    assert.deepEqual(f.calls, [], "capture failed: the table keeps its board");
    await upkeep(f, async () => true);
    assert.deepEqual(f.calls, ["reset 0"]);
  });

  it("survives a keeper restart in the middle of a reset: fresh memory, same chain, same step", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", seatsOpen: true, overAt: NOW - 100 });
    await upkeep(f); // seats wiped, then the keeper dies
    f.tables.get(0)!.view = view(0, { coarse: "over", seatsOpen: false, overAt: NOW - 100 });
    await upkeep(f); // a new process starts with empty memory
    await upkeep(f); // and a second pass before the chain moved is the same step again, never a different one
    assert.deepEqual(f.calls, ["seats 0", "reset 0", "reset 0"]);
    f.tables.get(0)!.view = view(0, { epoch: 4 });
    await upkeep(f);
    assert.equal(f.calls.length, 3, "reset done: the table is Idle at the next epoch and nothing is sent");
  });

  it("sends nothing in dry-run, and says what it would", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", dirty: true, overAt: NOW - 5 });
    f.sponsorBalance = 0;
    await runGame(ctxOf(f, { dryRun: true }), f.adapter(), STILL, [], newGameState(), { gate: gateOk, settings: SCHED });
    assert.deepEqual(f.calls, []);
  });

  it("raises an alert for a table Over for too long, and clears it when it is reset", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", overAt: NOW - 3000 });
    await runGame(ctxOf(f), f.adapter(), STILL, [], newGameState(), { gate: async () => false, settings: SCHED });
    assert.ok(keys().includes("tables:fake:stuck:0"));
    withTable(f, 0, {});
    await runGame(ctxOf(f), f.adapter(), STILL, [], newGameState(), { gate: gateOk, settings: SCHED });
    assert.ok(!keys().includes("tables:fake:stuck:0"));
  });
});

describe("assignment", () => {
  beforeEach(() => raisedConditions().forEach((c) => clearRaised(c.key)));
  const go = (f: Fake, matches: ReturnType<typeof matchOf>[], st = newGameState(), now = NOW) => runGame(ctxOf(f, { now }), f.adapter(), STILL, matches as never, st, { gate: gateOk, settings: SCHED });

  it("does not repeatedly pay to assign an unsupported Trading Duel asset, but still refunds it", async () => {
    const f = new Fake(); withTable(f, 0, {});
    const match = matchOf(12, { meta: { asset: 255 }, deadline: { toString: () => String(NOW + 3600 - 301) } });
    const adapter = { ...f.adapter(), id: "trading-duel" as const };
    await runGame(ctxOf(f), adapter, STILL, [match] as never, newGameState(), { gate: gateOk, settings: SCHED });
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), []);
    assert.equal(f.calls.filter((c) => c.startsWith("refund_untabled")).length, 1);
  });

  it("puts the oldest joined Match on an Idle table", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    await go(f, [matchOf(13), matchOf(12)]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), [`assign ${key(12).toBase58().slice(0, 4)}->0@3`]);
  });

  it("leaves Matches that have a table, are still Open, or are about to hit their deadline", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    f.assignments.set(key(12).toBase58(), { generation: 1, index: 5, epoch: 1, startDeadline: NOW + 100 });
    await go(f, [matchOf(12), matchOf(13, { deadline: { toString: () => String(NOW + 30) } }), { ...matchOf(14), stage: "open" }]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), []);
  });

  it("skips a Match whose Assignment cannot be read this pass", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    f.assignments.set(key(12).toBase58(), undefined);
    await go(f, [matchOf(12)]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), []);
  });

  it("does not hand one table two Matches", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    f.assignments.set(key(12).toBase58(), { generation: 1, index: 0, epoch: 3, startDeadline: NOW + 100 });
    await go(f, [matchOf(12), matchOf(13)]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), [], "table 0 is promised to Match 12 until its start window ends");
  });

  it("frees a table whose Assignment never began once the start window is over (the old in-memory promise held it forever)", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    f.assignments.set(key(12).toBase58(), { generation: 1, index: 0, epoch: 3, startDeadline: NOW - 1 });
    await go(f, [matchOf(12), matchOf(13)]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), [`assign ${key(13).toBase58().slice(0, 4)}->0@3`]);
  });

  it("assigns nothing when the keeper is not the operator, and says so", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    const ctx = ctxOf(f);
    f.operator = key(55);
    await runGame(ctx, f.adapter(), STILL, [matchOf(12)] as never, newGameState(), { gate: gateOk, settings: SCHED });
    assert.deepEqual(f.calls, []);
    assert.ok(keys().includes("tables:fake:operator"));
  });

  it("raises an alert for a Match that has waited for a table longer than TABLE_WAIT, and clears it when placed", async () => {
    const f = new Fake();
    f.maxTables = 0;
    f.refundFails = true;
    const st = newGameState();
    await go(f, [matchOf(12)], st, NOW);
    assert.ok(!keys().includes("tables:fake:wait"));
    await go(f, [matchOf(12)], st, NOW + 301);
    assert.ok(keys().includes("tables:fake:wait"));
    f.maxTables = 8;
    withTable(f, 0, {});
    await go(f, [matchOf(12)], st, NOW + 302);
    assert.ok(!keys().includes("tables:fake:wait"));
  });
});

describe("fast refunds (ticket 35)", () => {
  beforeEach(() => raisedConditions().forEach((c) => clearRaised(c.key)));
  const go = (f: Fake, matches: ReturnType<typeof matchOf>[], now = NOW, set = STILL) => runGame(ctxOf(f, { now }), f.adapter(), set, matches as never, newGameState(), { gate: gateOk, settings: SCHED });
  const refunds = (f: Fake) => f.calls.filter((c) => c.startsWith("refund_untabled"));
  const label = (n: number) => key(n).toBase58().slice(0, 4);

  it("refunds a joined Match no table took once the wait is over, and not a second sooner", async () => {
    const f = new Fake();
    f.maxTables = 0;
    await go(f, [matchOf(12)], NOW + 299);
    assert.deepEqual(refunds(f), []);
    await go(f, [matchOf(12)], NOW + 300);
    assert.deepEqual(refunds(f), [`refund_untabled ${label(12)}`]);
  });

  it("tries a free table first: a Match that can be placed at the wait's end is assigned, not refunded", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    await go(f, [matchOf(12)], NOW + 400);
    assert.deepEqual(refunds(f), []);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("assign")), [`assign ${label(12)}->0@3`]);
  });

  it("never refunds a Match that has an Assignment, one still Open, or one whose deadline was clamped", async () => {
    const f = new Fake();
    f.maxTables = 0;
    f.assignments.set(key(12).toBase58(), { generation: 1, index: 5, epoch: 1, startDeadline: NOW + 1000 });
    const clamped = matchOf(14, { deadlineAbs: { toString: () => String(NOW + 3600) } });
    await go(f, [matchOf(12), { ...matchOf(13), stage: "open" }, clamped], NOW + 1000);
    assert.deepEqual(refunds(f), []);
  });

  it("raises no alarm for a Match it refunded, and still does for one it could not", async () => {
    const f = new Fake();
    f.maxTables = 0;
    const st = newGameState();
    const again = (now: number) => runGame(ctxOf(f, { now }), f.adapter(), STILL, [matchOf(12)] as never, st, { gate: gateOk, settings: SCHED });
    await again(NOW);
    await again(NOW + 301);
    assert.ok(!keys().includes("tables:fake:wait"));
    f.refundFails = true;
    st.firstSeen.set(key(12).toBase58(), NOW);
    await again(NOW + 302);
    assert.ok(keys().includes("tables:fake:wait"));
  });

  it("gives up an Assignment whose window closed with its table Idle at its epoch", async () => {
    const f = new Fake();
    withTable(f, 0, {}, undefined);
    f.assignments.set(key(12).toBase58(), { generation: 1, index: 0, epoch: 3, startDeadline: NOW - 10 });
    await go(f, [matchOf(12)]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("skip")), [`skip ${label(12)}`]);
  });

  it("does not skip while the window is open, after the table moved on, or with a slot already written", async () => {
    const f = new Fake();
    withTable(f, 0, {});
    f.assignments.set(key(12).toBase58(), { generation: 1, index: 0, epoch: 3, startDeadline: NOW + 100 });
    await go(f, [matchOf(12)]);
    withTable(f, 1, { epoch: 4 });
    f.assignments.set(key(13).toBase58(), { generation: 1, index: 1, epoch: 3, startDeadline: NOW - 100 });
    withTable(f, 2, { ring: [{ state: 2, tesoroMatch: key(14), epoch: 3, at: NOW - 50 }, free] });
    f.assignments.set(key(14).toBase58(), { generation: 1, index: 2, epoch: 3, startDeadline: NOW - 100 });
    await go(f, [matchOf(13), matchOf(14)]);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("skip")), []);
  });

  it("does not skip a table that is on a Match or has no free ring slot", () => {
    const a = { match: key(12), index: 0, epoch: 3, startDeadline: NOW - 100 };
    assert.equal(planSkips([row(0, "delegated", { coarse: "match" })], [a], NOW).length, 0);
    assert.equal(planSkips([row(0, "delegated", { ring: fullRing() })], [a], NOW).length, 0);
    assert.equal(planSkips([row(0, "program", {})], [a], NOW).length, 0);
    assert.equal(planSkips([row(0)], [a], NOW).length, 1);
  });

  it("writes one slot per free ring slot when several Assignments expired on one table", () => {
    const mk = (n: number) => ({ match: key(n), index: 0, epoch: 3, startDeadline: NOW - 100 });
    assert.equal(planSkips([row(0)], [mk(12), mk(13), mk(14)], NOW).length, 2, "the view has two free slots");
  });

  it("derives a join time from the deadline like table_kit does", () => {
    assert.equal(untabledSince(NOW + 3600, NOW + 99999), NOW);
    assert.equal(untabledSince(NOW + 3600, NOW + 3600), null);
    assert.equal(dueForRefund([{ address: key(1), deadline: NOW + 3600, deadlineAbs: NOW + 9999 }], NOW + TABLE_WAIT_SECS).length, 1);
    assert.equal(dueForRefund([{ address: key(1), deadline: NOW + 3600, deadlineAbs: NOW + 9999 }], NOW + TABLE_WAIT_SECS - 1).length, 0);
  });
});

describe("making tables", () => {
  beforeEach(() => raisedConditions().forEach((c) => clearRaised(c.key)));
  const go = (f: Fake, matches: ReturnType<typeof matchOf>[], set = SET) => runGame(ctxOf(f), f.adapter(), set, matches as never, newGameState(), { gate: gateOk, settings: SCHED });
  const emptyTables = (f: Fake) => {
    for (let i = 0; i < 8; i++) f.tables.set(i, { base: "missing", view: null });
  };

  it("creates the first table with nothing waiting, then delegates and seats it over the next passes", async () => {
    const f = new Fake();
    emptyTables(f);
    await go(f, []);
    assert.deepEqual(f.calls, ["setup create_table 0 1"]);
    f.calls = [];
    f.tables.set(0, { base: "program", view: null });
    await go(f, []);
    assert.deepEqual(f.calls, ["setup delegate_table 0 1"]);
    f.calls = [];
    f.tables.set(0, { base: "delegated", view: view(0, { seatsCreated: false }) });
    await go(f, []);
    assert.deepEqual(f.calls, ["setup init_seats 0 1"]);
    f.calls = [];
    f.tables.set(0, { base: "delegated", view: view(0) });
    await go(f, []);
    assert.deepEqual(f.calls, [], "ready: nothing more to make");
  });

  it("makes more tables when Matches wait, two per pass, and raises the cap alarm at the cap", async () => {
    const f = new Fake();
    emptyTables(f);
    await go(f, [matchOf(12), matchOf(13), matchOf(14)]);
    assert.deepEqual(f.calls, ["setup create_table 0 1", "setup create_table 1 1"]);
    f.calls = [];
    for (let i = 0; i < 4; i++) f.tables.set(i, { base: "delegated", view: view(i, { coarse: "match" }) });
    await go(f, [matchOf(12), matchOf(13)]);
    assert.deepEqual(f.calls, []);
    assert.ok(keys().includes("tables:fake:cap"));
  });

  it("never makes a table before a Sponsor exists, and says so", async () => {
    const f = new Fake();
    emptyTables(f);
    f.sponsor = "missing";
    await go(f, [matchOf(12)]);
    assert.deepEqual(f.calls, []);
    assert.ok(keys().includes("tables:fake:sponsor-missing"));
  });

  it("creates the Sponsor and a Fuel when the keeper was given the lamports for it, and delegates ones it made", async () => {
    const f = new Fake();
    emptyTables(f);
    f.sponsor = "missing";
    f.fuel = "missing";
    await go(f, [], { ...SET, sponsorInit: 1n, fuelInit: 1n });
    assert.deepEqual(f.calls.slice(0, 2), ["setup create_sponsor 1", "setup create_fuel 0 1"]);
    f.calls = [];
    f.sponsor = "program";
    f.fuel = "program";
    await go(f, []);
    assert.deepEqual(f.calls.slice(0, 2), ["setup delegate_sponsor 1", "setup delegate_fuel 0 1"]);
  });

  it("makes no seats for a Game without private seats", async () => {
    const f = new Fake();
    f.tables.set(0, { base: "delegated", view: view(0, { seatsCreated: false }) });
    for (let i = 1; i < 8; i++) f.tables.set(i, { base: "missing", view: null });
    await runGame(ctxOf(f), f.adapter(false), { ...SET, spare: 0, min: 0 }, [], newGameState(), { gate: gateOk, settings: SCHED });
    assert.deepEqual(f.calls, []);
  });
});

describe("Sponsor fuel", () => {
  beforeEach(() => raisedConditions().forEach((c) => clearRaised(c.key)));
  const go = (f: Fake) => runGame(ctxOf(f), f.adapter(), { ...SET, min: 0, spare: 0 }, [], newGameState(), { gate: gateOk, settings: SCHED });

  it("refills a Sponsor under the floor", async () => {
    const f = new Fake();
    f.sponsorBalance = 1000;
    await go(f);
    assert.deepEqual(f.calls, ["refill"]);
    assert.ok(!keys().includes("tables:fake:sponsor"));
  });

  it("raises an alert when the refill fails, and clears it when the Sponsor is full again", async () => {
    const f = new Fake();
    f.sponsorBalance = 1000;
    f.refillFails = true;
    await go(f);
    assert.ok(keys().includes("tables:fake:sponsor"));
    f.refillFails = false;
    f.sponsorBalance = 90_000_000;
    await go(f);
    assert.ok(!keys().includes("tables:fake:sponsor"));
  });
});

describe("Assignment cleanup", () => {
  beforeEach(() => raisedConditions().forEach((c) => clearRaised(c.key)));
  it("closes the Assignment of a Match tesoro_core froze or deleted, and no other", async () => {
    const f = new Fake();
    f.assignmentAccounts = [key(21), key(22), key(23)];
    const accounts = new Map<string, unknown>();
    const { settledPda } = await import("../../app/src/lib/chain/basket.ts");
    accounts.set(key(21).toBase58(), { owner: key(1) }); // Match exists, no receipt: keep
    accounts.set(key(22).toBase58(), { owner: key(1) }); // Match exists, receipt: close
    accounts.set(settledPda(key(22)).toBase58(), { owner: key(1) });
    // Match 23 is gone: close
    await runGame(ctxOf(f, { accounts }), f.adapter(), { ...SET, min: 0, spare: 0 }, [], newGameState(), { gate: gateOk, settings: { ...SCHED, cleanupSecs: 0 } });
    assert.deepEqual(f.calls.filter((c) => c.startsWith("close")).sort(), [`close_assignment ${key(22).toBase58().slice(0, 4)}`, `close_assignment ${key(23).toBase58().slice(0, 4)}`].sort());
  });
});

describe("the job", () => {
  it("runs every Game, and one Game failing does not stop the others", async () => {
    const f = new Fake();
    withTable(f, 0, { coarse: "over", dirty: true, overAt: NOW - 5 });
    const ok = f.adapter();
    const bad = { ...f.adapter(), label: "bad", config: async () => Promise.reject(new Error("rpc down")) };
    const boom = { ...f.adapter(), label: "boom", config: () => { throw new Error("sync failure"); } };
    const ctx = ctxOf(f) as unknown as Record<string, any>;
    ctx.core.account = { matchState: { all: async () => [] } };
    const n = await tablesJob(ctx as unknown as Ctx, [boom as never, bad as never, ok]);
    assert.ok(n >= 1);
    assert.ok(f.calls.includes("commit 0"), "the healthy Game was still driven");
  });
});
