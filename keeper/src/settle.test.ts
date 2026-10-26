import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, bookBytes, ixNameOf, potBytes, storeBytes, ticketBytes, zeroOf } from "./fixtures.ts";
import { OVERFLOW_MATCH, POT_AT, basketOf, bookOf, ckptOf, countersOf, decodeStore, matchOverflowId, overflowAddress, spillOf } from "./kit.ts";
import { loadIdl } from "./runtime.ts";
import { CHUNK_CU_TARGET, closeRemaining, driveMatch, fullAccounts, planChunk, planSizedChunk, viewOf, type Deps, type MatchView } from "./settle.ts";
import type { Info, Reader } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const info = (data: Buffer): Info => ({ data, executable: false, lamports: 1, owner: PublicKey.default });
const reader = (accounts: Map<string, Buffer>): Reader => ({ async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? info(accounts.get(x.toBase58())!) : null)); } });

const alice = k();
const bob = k();
const potA = k();
const potB = k();
const matchAddr = k();
const payer = k();

async function matchView(over: { stage?: object; sources?: PublicKey[]; cut?: bigint[]; room?: { account: PublicKey; left: number }[]; phases?: object[] } = {}): Promise<MatchView> {
  const idl = core.idl as any;
  const run = zeroOf(idl, { defined: { name: "run" } });
  run.phases = [...(over.phases ?? [{ back: [0] }]), ...Array(4).fill({ back: [0] })].slice(0, 4);
  run.nPhases = (over.phases ?? [{ back: [0] }]).length;
  run.cutLeft = [[new anchor.BN(0), new anchor.BN(0), new anchor.BN(0)], (over.cut ?? [0n, 0n, 0n]).map((v) => new anchor.BN(v.toString()))];
  const bytes = await accountBytes(core, "MatchState", {
    inner: { id: { opener: alice.toBytes(), n: new anchor.BN(7) }, a: { player: alice.toBytes(), funder: alice.toBytes() }, b: { player: bob.toBytes(), funder: bob.toBytes(), shareBps: 0 }, stage: over.stage ?? { settling: {} }, run },
    payer,
    pots: [potA, potB],
  });
  const account: any = core.coder.accounts.decode("matchState", bytes);
  account.room = over.room ?? [];
  return viewOf(matchAddr, account);
}

function world(sources: PublicKey[], opts: { fullSpillOf?: PublicKey } = {}) {
  const accounts = new Map<string, Buffer>();
  for (const a of [alice, bob]) {
    accounts.set(basketOf(a).toBase58(), storeBytes([{ amount: 1n }], { account: a, capacity: 4 }));
    const full = opts.fullSpillOf?.equals(a);
    accounts.set(spillOf(a).toBase58(), storeBytes(full ? [{ amount: 1n }] : [], { account: a, capacity: full ? 1 : 3 }));
  }
  if (opts.fullSpillOf) accounts.set(basketOf(opts.fullSpillOf).toBase58(), storeBytes([{ amount: 1n }], { account: opts.fullSpillOf, capacity: 1 }));
  accounts.set(potA.toBase58(), ticketBytes({ account: alice, state: 2, payer: alice }, sources.map((s) => ({ source: s, amount: 5n, side: 1 }))));
  accounts.set(potB.toBase58(), ticketBytes({ account: bob, state: 2, payer: bob }, sources.map((s) => ({ source: s, amount: 5n }))));
  for (const s of sources) {
    accounts.set(bookOf(s).toBase58(), bookBytes([0, 0, 0, 0]));
  }
  return accounts;
}

const ctxOf = (dryRun = false): Ctx => ({ core, conn: { getBalance: async () => 1e9 }, payer: Keypair.generate(), settings: { dryRun }, budget: new Budget(1e15), lz: new Budget(1e15) }) as unknown as Ctx;

describe("planning a chunk", () => {
  it("brings the credited Accounts' stores and the books of the Sources the steps touch", async () => {
    const sources = [k(), k()];
    const view = await matchView();
    const l = { view, pots: [] as any, stores: [decodeStore(world(sources).get(potA.toBase58())!, POT_AT), decodeStore(world(sources).get(potB.toBase58())!, POT_AT)] };
    const plan = await planChunk(core, reader(world(sources)), payer, l, 4);
    const keys = new Set(plan!.ix.keys.map((x) => x.pubkey.toBase58()));
    for (const a of [alice, bob]) assert.ok(keys.has(basketOf(a).toBase58()) && keys.has(spillOf(a).toBase58()));
    // the run starts at Back(0): both lines of pot A
    for (const s of sources) assert.ok(keys.has(bookOf(s).toBase58()));
    assert.equal(ixNameOf(core, plan!.ix), "matchChunk");
    assert.equal(plan!.steps, 4);
  });

  it("brings the overflow record of an Account that has one for this Match, and only that one", async () => {
    const sources = [k()];
    const view = await matchView();
    const accounts = world(sources);
    const record = overflowAddress(alice, OVERFLOW_MATCH, matchOverflowId(view.ref));
    accounts.set(record.toBase58(), Buffer.alloc(300));
    const l = { view, pots: [] as any, stores: [decodeStore(accounts.get(potA.toBase58())!, POT_AT), decodeStore(accounts.get(potB.toBase58())!, POT_AT)] };
    const plan = await planChunk(core, reader(accounts), payer, l, 4);
    const keys = plan!.ix.keys.map((x) => x.pubkey.toBase58());
    assert.ok(keys.includes(record.toBase58()));
    assert.ok(!keys.includes(overflowAddress(bob, OVERFLOW_MATCH, matchOverflowId(view.ref)).toBase58()), "Bob has none");
  });
  it("asks for fewer steps when the accounts do not fit one transaction", async () => {
    const sources = Array.from({ length: 12 }, k);
    const view = await matchView();
    const accounts = world(sources);
    for (const s of sources) {
      accounts.set(bookOf(s).toBase58(), bookBytes([0, 40, 0, 40]));
      for (const cls of [1, 3]) for (const page of [0, 1, 2]) accounts.set(ckptOf(s, cls, page).toBase58(), Buffer.alloc(8));
    }
    const l = { view, pots: [] as any, stores: [decodeStore(accounts.get(potA.toBase58())!, POT_AT), decodeStore(accounts.get(potB.toBase58())!, POT_AT)] };
    const plan = await planChunk(core, reader(accounts), payer, l, 12);
    assert.ok(plan!.steps < 12 && plan!.steps >= 1, `steps ${plan!.steps}`);
  });

  it("takes fewer steps until the simulated chunk fits the compute target", async () => {
    const sources = Array.from({ length: 8 }, k);
    const view = await matchView();
    const accounts = world(sources);
    const l = { view, pots: [] as any, stores: [decodeStore(accounts.get(potA.toBase58())!, POT_AT), decodeStore(accounts.get(potB.toBase58())!, POT_AT)] };
    const tried: number[] = [];
    // 50,000 CU of loading plus 20,000 per step: the target allows (125,000 - 50,000) / 20,000 = 3 steps
    const simulate = async (ixs: any[]) => {
      const steps = ixs[0].data[8];
      tried.push(steps);
      return 50_000 + 20_000 * steps;
    };
    const d = { read: reader(accounts), simulate } as unknown as Deps;
    const plan = await planSizedChunk({ core, payer: Keypair.generate() }, d, l, {}, "match=test");
    assert.ok(plan!.steps >= 1 && 50_000 + 20_000 * plan!.steps <= CHUNK_CU_TARGET, `steps ${plan!.steps} after ${tried}`);
    assert.equal(plan!.steps, 3);
    assert.ok(tried[0] > plan!.steps, `started above the final size: ${tried}`);
  });

  it("sends the chunk as planned when its compute cannot be measured, and keeps one step when even that is over", async () => {
    const sources = Array.from({ length: 8 }, k);
    const view = await matchView();
    const accounts = world(sources);
    const l = { view, pots: [] as any, stores: [decodeStore(accounts.get(potA.toBase58())!, POT_AT), decodeStore(accounts.get(potB.toBase58())!, POT_AT)] };
    const blind = await planSizedChunk({ core, payer: Keypair.generate() }, { read: reader(accounts), simulate: async () => null } as unknown as Deps, l, {}, "match=test");
    assert.equal(blind!.steps, 6);
    const heavy = await planSizedChunk({ core, payer: Keypair.generate() }, { read: reader(accounts), simulate: async () => 900_000 } as unknown as Deps, l, {}, "match=test");
    assert.equal(heavy!.steps, 1);
  });

  it("reports a Source whose book is missing", async () => {
    const s = k();
    const view = await matchView();
    const accounts = world([s]);
    accounts.delete(bookOf(s).toBase58());
    const l = { view, pots: [] as any, stores: [decodeStore(accounts.get(potA.toBase58())!, POT_AT), decodeStore(accounts.get(potB.toBase58())!, POT_AT)] };
    assert.deepEqual((await planChunk(core, reader(accounts), payer, l, 4))!.missing.map((m) => m.toBase58()), [s.toBase58()]);
  });

  it("finds the Accounts whose basket and spill are full", async () => {
    const full = await fullAccounts(reader(world([], { fullSpillOf: bob })), [alice, bob]);
    assert.deepEqual(full.map((a) => a.toBase58()), [bob.toBase58()]);
  });
});

describe("closing", () => {
  it("passes the spill of every Account that still holds room, and both Players' counters", async () => {
    const studio = k();
    const view = await matchView({ stage: { closed: {} }, room: [{ account: studio, left: 2 }, { account: alice, left: 1 }] });
    const keys = closeRemaining(view).map((m) => m.pubkey.toBase58());
    assert.deepEqual(keys, [spillOf(studio), spillOf(alice), countersOf(alice), countersOf(bob)].map((x) => x.toBase58()));
  });
});

describe("driving a Match", () => {
  function deps(script: { next: MatchView[]; reports: ({ done: boolean; blocked: boolean } | null)[]; accounts: Map<string, Buffer> }) {
    const sent: string[] = [];
    const d: Deps = {
      read: reader(script.accounts),
      send: async (ixs) => {
        sent.push(ixs.map((i) => ixNameOf(core, i)).join("+"));
        return `sig${sent.length}`;
      },
      refetch: async () => script.next.shift() ?? null,
      report: async (_sig, ref) => {
        const r = script.reports.shift();
        return r ? { type: "chunk", opener: ref.opener.toBase58(), n: ref.n, chunkNo: 1, steps: 1, ...r } : null;
      },
      tables: async () => [],
    };
    return { d, sent };
  }

  it("runs chunks until the run is done, then closes the Match", async () => {
    const s = k();
    const accounts = world([s]);
    const settling = await matchView();
    const closed = await matchView({ stage: { closed: {} } });
    const { d, sent } = deps({ next: [settling, closed], reports: [{ done: false, blocked: false }, { done: true, blocked: false }], accounts });
    const n = await driveMatch(ctxOf(), settling, d);
    assert.deepEqual(sent, ["matchChunk", "matchChunk", "closeMatch"]);
    assert.equal(n, 3);
  });

  it("creates missing checkpoint pages before a fee cut seals the paid Studio tranche", async () => {
    const source = k();
    const accounts = world([source]);
    const settling = await matchView({ phases: [{ cuts: [1] }], cut: [1n, 1n, 1n] });
    const closed = await matchView({ stage: { closed: {} } });
    const { d, sent } = deps({ next: [closed], reports: [{ done: true, blocked: false }], accounts });
    const send = d.send;
    d.send = async (ixs, opts) => {
      for (const ix of ixs) {
        if (ixNameOf(core, ix) === "initCkptPage") accounts.set(ix.keys[2].pubkey.toBase58(), Buffer.alloc(10));
        if (ixNameOf(core, ix) === "matchChunk") {
          const studioPage = ckptOf(source, 1, 0).toBase58();
          assert.ok(accounts.has(studioPage), "Create the Studio checkpoint page before settling a fee cut");
          assert.ok(ix.keys.some((k) => k.pubkey.toBase58() === studioPage));
        }
      }
      return send(ixs, opts);
    };
    await driveMatch(ctxOf(), settling, d);
    assert.deepEqual(sent, ["initCkptPage", "initCkptPage", "matchChunk", "closeMatch"]);
  });

  it("grows the spill of the Account that has no room when the chunk reports blocked, then goes on", async () => {
    const accounts = world([k()], { fullSpillOf: bob });
    const settling = await matchView();
    const closed = await matchView({ stage: { closed: {} } });
    const { d, sent } = deps({ next: [settling, closed], reports: [{ done: false, blocked: true }, { done: true, blocked: false }], accounts });
    await driveMatch(ctxOf(), settling, d);
    assert.deepEqual(sent, ["matchChunk", "growStore", "matchChunk", "closeMatch"]);
  });

  it("sends nothing in dry-run mode", async () => {
    const accounts = world([k()]);
    const { d, sent } = deps({ next: [], reports: [], accounts });
    assert.equal(await driveMatch(ctxOf(true), await matchView(), d), 0);
    assert.deepEqual(sent, []);
  });

  it("leaves an Open or Active Match to its Game", async () => {
    const accounts = world([]);
    const { d, sent } = deps({ next: [], reports: [], accounts });
    assert.equal(await driveMatch(ctxOf(), await matchView({ stage: { active: {} } }), d), 0);
    assert.deepEqual(sent, []);
  });
});
