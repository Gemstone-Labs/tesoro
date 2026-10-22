import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { awayAccounts, planAway } from "./away.ts";

const NOW = 1_800_000_000;
const alice = Keypair.generate().publicKey;
const bob = Keypair.generate().publicKey;
const carol = Keypair.generate().publicKey;
const n = (v: number) => ({ toString: () => String(v) });
const st = (name: string) => ({ [name]: {} });
const prot = (account: typeof alice, breakUntil: number, selfExclusionUntil = 0) => ({ account, inner: { breakUntil: n(breakUntil), selfExclusionUntil: n(selfExclusionUntil) } });

describe("away accounts", () => {
  it("lists Accounts on a Break or Self-Excluded, and drops ended ones", () => {
    const away = awayAccounts([prot(alice, NOW + 10), prot(bob, NOW - 1), prot(carol, 0, NOW + 5)], NOW);
    assert.deepEqual([...away].sort(), [alice.toBase58(), carol.toBase58()].sort());
    assert.equal(awayAccounts([prot(alice, NOW)], NOW).size, 0);
  });
});

describe("away clean-up plan", () => {
  const away = new Set([alice.toBase58()]);
  const game = Keypair.generate().publicKey;
  const match = (id: number, stage: string, opener: typeof alice) => ({ ref: { opener, n: BigInt(id) }, stage, game, opener });
  const request = (status: string, owner: typeof alice) => ({ publicKey: Keypair.generate().publicKey, account: { inner: { status: st(status), player: owner.toBytes() } } });
  const offer = (status: string, backer: typeof alice) => ({ publicKey: Keypair.generate().publicKey, account: { inner: { status: st(status), backer: backer.toBytes() } } });

  it("refunds unpaired Matches of an away opener only", () => {
    const plan = planAway(away, [match(1, "open", alice), match(2, "active", alice), match(3, "open", bob), match(4, "settling", alice)], [], []);
    assert.deepEqual(plan.map((p) => p.kind === "refund" && p.match.n), [1n]);
  });

  it("withdraws open Requests and unused Offers of away Players only", () => {
    const plan = planAway(away, [], [request("open", alice), request("accepted", alice), request("open", bob)], [offer("open", alice), offer("accepted", alice), offer("consumed", alice), offer("open", bob)]);
    assert.deepEqual(plan.map((p) => p.kind), ["clear-request", "withdraw-offer", "withdraw-offer"]);
  });

  it("does nothing when nobody is away", () => {
    assert.deepEqual(planAway(new Set(), [match(1, "open", alice)], [request("open", alice)], [offer("open", alice)]), []);
  });
});
