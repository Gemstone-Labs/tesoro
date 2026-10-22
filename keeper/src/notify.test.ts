import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { VANGUARD_PROGRAM_ID } from "../../app/src/games/vanguard/chain.ts";
import type { MatchRunStartedRecord } from "../../app/src/server/history/events.ts";
import anchor from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, chainOf } from "./fixtures.ts";
import { loadIdl } from "./runtime.ts";
import { gameOfKey, notifyJob, pushSettled, settledPush } from "./notify.ts";

const [A, B, C] = [1, 2, 3].map(() => Keypair.generate().publicKey.toBase58());
const authority = (a: string) => ({ [A]: "walletA", [B]: "walletB", [C]: "walletC" })[a];

const start = (over: Partial<MatchRunStartedRecord> = {}): MatchRunStartedRecord => ({
  type: "start",
  opener: A,
  n: 123n,
  game: VANGUARD_PROGRAM_ID.toBase58(),
  kind: 0,
  winnerSide: 0,
  entry: 1000,
  fees: [60, 40, 20],
  aPlayer: A,
  aFunder: A,
  bPlayer: B,
  bFunder: B,
  challenge: false,
  asset: 0,
  openedAt: 1,
  ts: 2,
  aShareBps: 0,
  bShareBps: 0,
  ...over,
});

describe("settled Match event for the app", () => {
  it("tells the winner their Gemas after Fees and the loser the entry", () => {
    const p = settledPush(start(), "vanguard", authority)!;
    assert.equal(p.matchId, `${A}-123`);
    assert.deepEqual(p.participants, [
      { authority: "walletA", result: "won", gemas: 1000 - 120 },
      { authority: "walletB", result: "lost", gemas: 1000 },
    ]);
  });

  it("reads a joiner win and a draw", () => {
    assert.deepEqual(settledPush(start({ winnerSide: 1 }), "vanguard", authority)!.participants.map((x) => x.result), ["lost", "won"]);
    const d = settledPush(start({ kind: 2, winnerSide: null }), "vanguard", authority)!;
    assert.deepEqual(d.participants.map((x) => [x.result, x.gemas]), [["draw", 0], ["draw", 0]]);
  });

  it("gives a backed Player only their share, and a backed loss costs them nothing", () => {
    const backed = { aFunder: C, aShareBps: 5000 };
    const won = settledPush(start(backed), "vanguard", authority)!;
    assert.equal(won.participants[0].gemas, Math.floor((1000 - 120) / 2));
    const lost = settledPush(start({ ...backed, winnerSide: 1 }), "vanguard", authority)!;
    assert.deepEqual(lost.participants[0], { authority: "walletA", result: "lost", gemas: 0 });
  });

  it("says nothing of refunds, no-shows and Matches nobody joined", () => {
    assert.equal(settledPush(start({ kind: 3, winnerSide: null, bPlayer: null, bFunder: null }), "vanguard", authority), null);
    assert.equal(settledPush(start({ kind: 1, winnerSide: null }), "vanguard", authority), null);
  });

  it("leaves out a Player whose wallet is unknown", () => {
    assert.deepEqual(settledPush(start(), "vanguard", (a) => (a === A ? "walletA" : undefined))!.participants.map((p) => p.authority), ["walletA"]);
  });
});

describe("push to the app", () => {
  it("posts the event with the shared secret and reports whether the server took it", async () => {
    const push = settledPush(start(), "vanguard", authority)!;
    let seen: { url: string; init: any } | undefined;
    const ok = (async (url: string, init: any) => ((seen = { url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    assert.equal(await pushSettled("https://x/api/notify/event", "s", push, ok), "sent");
    assert.equal(seen?.init.headers.authorization, "Bearer s");
    assert.equal(JSON.parse(seen?.init.body).matchId, `${A}-123`);
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    assert.equal(await pushSettled("u", "s", push, bad), "failed");
    // a Game the app does not take: final, the keeper stops asking
    const malformed = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    assert.equal(await pushSettled("u", "s", push, malformed), "rejected");
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.equal(await pushSettled("u", "s", push, down), "failed");
  });
});

describe("gameOfKey", () => {
  it("knows the Vanguard program and no stranger", () => {
    assert.equal(gameOfKey(VANGUARD_PROGRAM_ID), "vanguard");
    assert.equal(gameOfKey(PublicKey.default), null);
  });
});

describe("the notify job", () => {
  const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
  const NOW = 1_800_000_000;
  const env = { NOTIFY_URL: "https://x/api/notify/event", NOTIFY_SECRET: "s" } as NodeJS.ProcessEnv;

  async function ctx() {
    const accounts = new Map<string, Buffer>();
    for (const [key, wallet] of [[A, Keypair.generate().publicKey], [B, Keypair.generate().publicKey]] as const) accounts.set(key, await accountBytes(core, "TesoroAccount", { authority: wallet }));
    return { core: chainOf(core, accounts), now: NOW, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
  }

  it("announces a settled Match from the history feed once, and keeps one the app did not take for the next pass", async () => {
    const queue = [{ start: start({ n: 5n }), blockTime: NOW - 60 }];
    const posted: string[] = [];
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const up = (async (_u: string, init: any) => (posted.push(JSON.parse(init.body).matchId), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    const c = await ctx();
    assert.equal(await notifyJob(c, env, queue, down), 0);
    assert.equal(queue.length, 1, "kept to retry");
    assert.equal(await notifyJob(c, env, queue, up), 1);
    assert.deepEqual([posted, queue.length], [[`${A}-5`], 0]);
  });

  it("drops old Matches, refunds and games the app does not play without asking", async () => {
    const queue = [
      { start: start({ n: 6n }), blockTime: NOW - 10 * 86_400 },
      { start: start({ n: 7n, kind: 3, winnerSide: null, bPlayer: null, bFunder: null }), blockTime: NOW },
      { start: start({ n: 8n, game: PublicKey.default.toBase58() }), blockTime: NOW },
    ];
    let calls = 0;
    const fetchFn = (async () => (calls++, new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    assert.equal(await notifyJob(await ctx(), env, queue, fetchFn), 0);
    assert.deepEqual([calls, queue.length], [0, 0]);
  });

  it("does nothing without the app's address", async () => {
    const queue = [{ start: start({ n: 9n }), blockTime: NOW }];
    assert.equal(await notifyJob(await ctx(), {} as NodeJS.ProcessEnv, queue), 0);
    assert.equal(queue.length, 1);
  });
});
