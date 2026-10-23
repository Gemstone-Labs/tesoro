import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { PAYOUT_WINDOW_SECS, SEASON_EPOCH, SEASON_SECS, type Standing } from "../../app/src/lib/chain/season.ts";
import { accountBytes, chainOf, ixNameOf } from "./fixtures.ts";
import { basketOf, economyAddress, pda, spillOf } from "./kit.ts";
import { storeBytes } from "./fixtures.ts";
import { loadIdl } from "./runtime.ts";
import { groupsOf, payPlan, rankShare, rankTotal, readRoute, routesToFund, seasonJob, seasonOf, seasonPoints, seasonSigner, seasonsToCheck, topRanks, type SeasonDeps, type SeasonRecord } from "./season.ts";
import { SIM_SOL_MINT, type Info, type Reader } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const win = (player: string, points: number, ts: number) => ({ player, points, ts, matchId: `${player}${ts}` });

describe("season schedule", () => {
  it("looks at finished seasons only, after the grace period", () => {
    const end1 = SEASON_EPOCH + SEASON_SECS;
    assert.deepEqual(seasonsToCheck(SEASON_EPOCH + 5, 600), [], "season 1 is running");
    assert.deepEqual(seasonsToCheck(end1 + 599, 600), [], "ended, still in the grace period");
    assert.deepEqual(seasonsToCheck(end1 + 600, 600), [1]);
    assert.deepEqual(seasonsToCheck(end1 + SEASON_SECS + 700, 600), [1, 2]);
    assert.equal(seasonsToCheck(end1 + 10 * SEASON_SECS + 700, 600, 4).length, 4, "only the last few are checked");
  });
  it("does nothing before the first season", () => {
    assert.deepEqual(seasonsToCheck(SEASON_EPOCH - 1000), []);
  });
});

describe("ranking", () => {
  it("keeps the top ten of the table", () => {
    const wins = Array.from({ length: 14 }, (_, i) => win(`p${String(i).padStart(2, "0")}`, 5 + i, 100 + i));
    const top = topRanks(wins);
    assert.equal(top.length, 10);
    assert.deepEqual([top[0].account, top[0].points, top[9].points], ["p13", 18, 9]);
  });
  it("encodes each ranked Player's points as a u64 argument", () => {
    const pts = seasonPoints([{ account: "a", points: 50 }, { account: "b", points: 35 }] as Standing[]);
    assert.deepEqual(pts.map((p) => p.toString()), ["50", "35"]);
  });
});

describe("points cap per opponent", () => {
  const w = (player: string, loser: string | undefined, n: number) => ({ player, loser, points: 10, ts: 100 + n, matchId: String(n) });
  it("the 4th win against the same opponent earns 0 Points", () => {
    const top = topRanks([1, 2, 3, 4, 5].map((n) => w("a", "b", n)));
    assert.deepEqual([top[0].points, top[0].wins], [30, 5]);
  });
  it("counts each opponent on its own and by event time, and never caps unnamed losers", () => {
    const wins = [w("a", "c", 9), w("a", "b", 4), w("a", "b", 3), w("a", "b", 2), w("a", "b", 1), w("a", undefined, 5), w("a", undefined, 6), w("a", undefined, 7), w("a", undefined, 8)];
    assert.equal(topRanks(wins)[0].points, 30 + 10 + 40);
  });
});

const line = (amount: bigint, paid = 0n) => ({ source: k(), amount, paid });
const rec = (over: Partial<SeasonRecord> = {}): SeasonRecord => ({ number: 1, count: 3, winners: [k(), k(), k()], points: [9n, 5n, 1n], lines: [line(1000n), line(400n)], cursor: [0, 0, 0], recordedAt: 10_000, voidedMask: 0, closed: false, ...over });

describe("what each rank is paid", () => {
  it("is the same share of every budget line, rounded down, like the program", () => {
    const r = rec();
    assert.equal(rankShare(r.lines[0], 0), 250n, "25% of 1000");
    assert.equal(rankShare(r.lines[1], 1), 72n, "18% of 400");
    assert.equal(rankTotal(r, 2), 130n + 52n);
  });
});

describe("payout plan", () => {
  const opens = 10_000 + PAYOUT_WINDOW_SECS;
  it("waits 48 hours after the record, then pays every step, rank by rank", () => {
    assert.deepEqual(payPlan(rec(), opens - 1), { kind: "wait", until: opens });
    const plan = payPlan(rec({ count: 2 }), opens);
    assert.deepEqual(plan.kind === "pay" && plan.steps, [{ rank: 0, line: 0 }, { rank: 0, line: 1 }, { rank: 1, line: 0 }, { rank: 1, line: 1 }]);
  });
  it("resumes each rank at its cursor and skips voided ranks", () => {
    const plan = payPlan(rec({ cursor: [2, 1, 0], voidedMask: 0b100 }), opens);
    assert.deepEqual(plan.kind === "pay" && plan.steps, [{ rank: 1, line: 1 }]);
  });
  it("closes the season once everything is paid or voided, and is done after", () => {
    assert.deepEqual(payPlan(rec({ cursor: [2, 2, 0], voidedMask: 0b100 }), opens), { kind: "close" });
    assert.deepEqual(payPlan(rec({ closed: true }), opens), { kind: "done" });
  });
  it("groups steps into transactions", () => {
    assert.deepEqual(groupsOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
});

describe("reading the chain", () => {
  it("reads a SeasonState", async () => {
    const [a, b, src] = [k(), k(), k()];
    const bytes = await accountBytes(core, "SeasonState", {
      inner: {
        number: 4,
        window: { number: 4, recordedAt: new anchor.BN(12345), voidedMask: 2 },
        count: 2,
        winners: [[...a.toBytes()], [...b.toBytes()], ...Array(8).fill(Array(32).fill(0))],
        points: [new anchor.BN(9), new anchor.BN(4), ...Array(8).fill(new anchor.BN(0))],
        lines: [{ side: 1, class: 3, tranche: 0, dueAt: new anchor.BN(0), source: [...src.toBytes()], amount: new anchor.BN(700), paid: new anchor.BN(250) }],
        cursor: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    });
    const r = seasonOf(core.coder.accounts.decode("seasonState", bytes));
    assert.deepEqual([r.number, r.count, r.recordedAt, r.voidedMask, r.cursor.slice(0, 2)], [4, 2, 12345, 2, [1, 0]]);
    assert.deepEqual(r.winners.map((w) => w.toBase58()), [a.toBase58(), b.toBase58()]);
    assert.deepEqual([r.lines[0].amount, r.lines[0].paid, r.lines[0].source.toBase58()], [700n, 250n, src.toBase58()]);
  });

  it("tells a native custody from a stake custody and reads its escrow switch", async () => {
    const [nat, stake, pool, mint] = [k(), k(), k(), k()];
    const accounts = new Map<string, Buffer>([
      [nat.toBase58(), await accountBytes(core, "NativeCustody", { pool, mint: SIM_SOL_MINT, route: { escrowEnabled: true, lastFunded: 2 } })],
      [stake.toBase58(), await accountBytes(core, "StakeCustody", { pool, mint })],
    ]);
    const read: Reader = { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } };
    const a = await readRoute(core as any, read, nat);
    const b = await readRoute(core as any, read, stake);
    assert.deepEqual([a!.kind, a!.escrowEnabled, a!.lastFunded], ["native", true, 2]);
    assert.deepEqual([b!.kind, b!.escrowEnabled, b!.mint.toBase58()], ["stake", false, mint.toBase58()]);
    assert.equal(await readRoute(core as any, read, k()), null);
    assert.deepEqual(routesToFund([a!, b!], 3).map((r) => r.kind), ["native"]);
    assert.deepEqual(routesToFund([a!, b!], 2), [], "already funded for this season");
  });

  it("signs with the key the Economy settings name, or not at all", () => {
    const [payer, oracle] = [Keypair.generate(), Keypair.generate()];
    assert.equal(seasonSigner(oracle.publicKey, [payer, oracle]), oracle);
    assert.equal(seasonSigner(payer.publicKey, [payer, null]), payer);
    assert.equal(seasonSigner(k(), [payer, oracle]), null);
  });
});

describe("the season job", () => {
  const payer = Keypair.generate();
  const alice = k();
  const bob = k();
  const poolAccount = k();
  const custody = k();
  const startOf = 1;
  const nowAt = SEASON_EPOCH + SEASON_SECS + 700;

  async function world(extra: Map<string, Buffer> = new Map()) {
    const accounts = new Map<string, Buffer>(extra);
    accounts.set(pda("config").toBase58(), await accountBytes(core, "Config", { poolAccount }));
    accounts.set(economyAddress.toBase58(), await accountBytes(core, "EconomyConfig", { seasonKeeper: payer.publicKey, routes: [custody, PublicKey.default, PublicKey.default, PublicKey.default] }));
    accounts.set(custody.toBase58(), await accountBytes(core, "NativeCustody", { pool: k(), mint: SIM_SOL_MINT, route: { escrowEnabled: true, lastFunded: 0 } }));
    for (const a of [alice, bob]) {
      accounts.set(basketOf(a).toBase58(), storeBytes([], { account: a, capacity: 8 }));
      accounts.set(spillOf(a).toBase58(), storeBytes([], { account: a, capacity: 8 }));
    }
    return accounts;
  }

  function run(accounts: Map<string, Buffer>, wins: { player: string; points: number; ts: number; matchId: string }[]) {
    const sent: string[] = [];
    const reader: Reader = { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } };
    const deps: SeasonDeps = {
      read: reader,
      send: async (ixs) => (sent.push(ixs.map((i) => ixNameOf(core, i)).join("+")), `sig${sent.length}`),
      wins: async () => wins,
      epoch: async () => 5n,
      candidates: () => [payer],
    };
    const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer, now: nowAt, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { sent, go: () => seasonJob(ctx, deps) };
  }

  const wins = [win(alice.toBase58(), 10, SEASON_EPOCH + 100), win(bob.toBase58(), 5, SEASON_EPOCH + 200)];

  it("funds the route that has its escrow on, then records the ranking", async () => {
    const { sent, go } = run(await world(), wins);
    assert.equal(await go(), 2);
    assert.deepEqual(sent, ["fundSeasonPrizeNative", "recordSeason"]);
  });

  it("does nothing for a season with no wins", async () => {
    const { sent, go } = run(await world(), []);
    assert.equal(await go(), 0);
    assert.deepEqual(sent, []);
  });

  it("waits inside the payout window, then pays every step and finally closes the season", async () => {
    const accounts = await world();
    const source = k();
    const recorded = async (cursor: number[], recordedAt: number, closed = false) =>
      accountBytes(core, "SeasonState", {
        inner: {
          number: startOf,
          window: { number: startOf, recordedAt: new anchor.BN(recordedAt), voidedMask: 0 },
          count: 2,
          winners: [[...alice.toBytes()], [...bob.toBytes()], ...Array(8).fill(Array(32).fill(0))],
          lines: [{ side: 1, class: 3, tranche: 0, dueAt: new anchor.BN(0), source: [...source.toBytes()], amount: new anchor.BN(1000), paid: new anchor.BN(0) }],
          cursor,
          closed,
        },
      });
    const season = pda("season", Buffer.from([1, 0, 0, 0]));
    accounts.set(season.toBase58(), await recorded([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], nowAt - 3600));
    const waiting = run(accounts, wins);
    assert.equal(await waiting.go(), 0);
    assert.deepEqual(waiting.sent, []);

    accounts.set(season.toBase58(), await recorded([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], nowAt - PAYOUT_WINDOW_SECS - 10));
    const paying = run(accounts, wins);
    assert.equal(await paying.go(), 2);
    assert.deepEqual(paying.sent, ["paySeasonRank+paySeasonRank"]);

    accounts.set(season.toBase58(), await recorded([1, 1, 0, 0, 0, 0, 0, 0, 0, 0], nowAt - PAYOUT_WINDOW_SECS - 10));
    const closing = run(accounts, wins);
    await closing.go();
    assert.deepEqual(closing.sent, ["closeSeason"]);
  });

  it("makes room in a winner's stores before paying", async () => {
    const accounts = await world();
    accounts.set(basketOf(alice).toBase58(), storeBytes([{ amount: 1n }, { amount: 1n }], { account: alice, capacity: 2 }));
    accounts.set(spillOf(alice).toBase58(), storeBytes([], { account: alice, capacity: 0 }));
    const source = k();
    accounts.set(
      pda("season", Buffer.from([1, 0, 0, 0])).toBase58(),
      await accountBytes(core, "SeasonState", {
        inner: {
          number: 1,
          window: { number: 1, recordedAt: new anchor.BN(nowAt - PAYOUT_WINDOW_SECS - 10), voidedMask: 0 },
          count: 1,
          winners: [[...alice.toBytes()], ...Array(9).fill(Array(32).fill(0))],
          lines: [{ side: 1, class: 3, tranche: 0, dueAt: new anchor.BN(0), source: [...source.toBytes()], amount: new anchor.BN(1000), paid: new anchor.BN(0) }],
        },
      }),
    );
    const { sent, go } = run(accounts, wins);
    await go();
    assert.deepEqual(sent, ["growStore+paySeasonRank"]);
  });
  it("does not grow a winner whose stores are at the maximum: the prize goes to an overflow record", async () => {
    const accounts = await world();
    const full = Array.from({ length: 32_768 }, (_, i) => ({ amount: 1n, dueAt: BigInt(i) }));
    accounts.set(basketOf(alice).toBase58(), storeBytes(full, { account: alice }));
    accounts.set(spillOf(alice).toBase58(), storeBytes(full, { account: alice }));
    const source = k();
    accounts.set(
      pda("season", Buffer.from([1, 0, 0, 0])).toBase58(),
      await accountBytes(core, "SeasonState", {
        inner: {
          number: 1,
          window: { number: 1, recordedAt: new anchor.BN(nowAt - PAYOUT_WINDOW_SECS - 10), voidedMask: 0 },
          count: 1,
          winners: [[...alice.toBytes()], ...Array(9).fill(Array(32).fill(0))],
          lines: [{ side: 1, class: 3, tranche: 0, dueAt: new anchor.BN(0), source: [...source.toBytes()], amount: new anchor.BN(1000), paid: new anchor.BN(0) }],
        },
      }),
    );
    const { sent, go } = run(accounts, wins);
    await go();
    assert.deepEqual(sent, ["paySeasonRank"]);
  });
});
