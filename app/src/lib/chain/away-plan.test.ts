import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { awayAccounts, planAway, type AwayOffer, type AwayRequest, type OpenMatchRow } from "./away-plan";

const NOW = 1_800_000_000;
const ana = Keypair.generate().publicKey;
const ben = Keypair.generate().publicKey;
const cat = Keypair.generate().publicKey;
const game = Keypair.generate().publicKey;
const match = (id: string, stage: OpenMatchRow["stage"], opener = ana): OpenMatchRow => ({ id, stage, game, opener });
const request = (status: string, player = ana): AwayRequest => ({ address: Keypair.generate().publicKey, status, player });
const offer = (status: string, backer = ana, req = Keypair.generate().publicKey): AwayOffer => ({ address: Keypair.generate().publicKey, status, backer, request: req });

describe("who is away", () => {
  it("lists Accounts on a Break or Self-Excluded and drops ended ones", () => {
    const away = awayAccounts(
      [
        { account: ana, breakUntil: NOW + 10, selfExclusionUntil: 0 },
        { account: ben, breakUntil: NOW - 1, selfExclusionUntil: 0 },
        { account: cat, breakUntil: 0, selfExclusionUntil: NOW + 5 },
      ],
      NOW,
    );
    expect([...away].sort()).toEqual([ana.toBase58(), cat.toBase58()].sort());
    expect(awayAccounts([{ account: ana, breakUntil: NOW, selfExclusionUntil: 0 }], NOW).size).toBe(0);
  });
});

describe("the clean-up plan for away Accounts", () => {
  const away = new Set([ana.toBase58()]);
  it("refunds unpaired Matches only: a paired, settling or someone else's Match is left alone", () => {
    const plan = planAway(away, [match("1", "open"), match("2", "active"), match("3", "open", ben), match("4", "settling")], [], []);
    expect(plan.map((s) => s.kind === "refund-match" && s.matchId)).toEqual(["1"]);
  });
  it("withdraws open Requests and releases Open and Accepted Offers of away Players only", () => {
    const accepted = offer("accepted");
    const plan = planAway(away, [], [request("open"), request("accepted"), request("open", ben)], [offer("open"), accepted, offer("consumed"), offer("open", ben)]);
    expect(plan.map((s) => s.kind)).toEqual(["cancel-request", "cancel-offer", "cancel-offer"]);
    // an accepted Offer hands its Request back, so the step names it; an open Offer names none
    expect(plan.filter((s) => s.kind === "cancel-offer").map((s) => s.kind === "cancel-offer" && s.request)).toEqual([null, accepted.request]);
  });
  it("does nothing when nobody is away", () => {
    expect(planAway(new Set(), [match("1", "open")], [request("open")], [offer("open")])).toEqual([]);
  });
  it("names the Account each step belongs to", () => {
    const plan = planAway(new Set([ana.toBase58(), ben.toBase58()]), [match("1", "open", ben)], [request("open")], []);
    expect(plan.map((s) => s.owner.toBase58())).toEqual([ben.toBase58(), ana.toBase58()]);
  });
});
