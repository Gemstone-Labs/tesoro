import { TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { accountOf, coreIx, key, playerIx } from "@/server/sponsor/fixtures";
import { MAX_CLEANUP, planTransaction } from "@/server/sponsor/rules";
import { awayStepIx, cleanupOrder, sendAwayBundles, stepsThatFit, stillBoarding, type BoardingSeat } from "./away-flow";
import { stepOffIx } from "./many-seat";
import { protectionsPda } from "./native";

const toWeb3 = (ix: { programId: any; keys: any[]; data: any }) => new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data) });
const player = key();
const relayer = key();
const game = key();
const refund = async () => toWeb3(await coreIx("refund_match", [], { caller: player, payer: relayer, gameProgram: game, programData: key(), gameRecord: key(), matchState: key(), openerProtections: key() }));

describe("how many clean-up steps fit one sponsored transaction", () => {
  it("all of a Player's withdrawn Requests fit up to the sponsor's bundle limit", async () => {
    const lead = [toWeb3(await coreIx("set_break", [3], { ownerAuthority: player }))];
    const steps = await Promise.all(Array.from({ length: 12 }, async () => toWeb3(await playerIx.cancelRequest(player))));
    expect(stepsThatFit(relayer, lead, steps)).toBe(MAX_CLEANUP);
  });
  it("refunds are big: the packed prefix still fits one transaction and one more would not (or hit the limit)", async () => {
    const lead = [toWeb3(await coreIx("set_break", [3], { ownerAuthority: player }))];
    const steps = await Promise.all(Array.from({ length: 8 }, refund));
    const n = stepsThatFit(relayer, lead, steps);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(MAX_CLEANUP);
  });
  it("always takes at least one step so a plan can make progress, and none from an empty list", async () => {
    expect(stepsThatFit(relayer, [], [])).toBe(0);
    const steps = [await refund()];
    expect(stepsThatFit(relayer, [], steps)).toBe(1);
  });
});

describe("the clean-up's released Offer", () => {
  // The W3 core gives an Offer's Entry Limit count back and needs the Backer's Protections for it.
  it("carries the Backer's Protections, writable, and the sponsor pays for it", async () => {
    const ix = await awayStepIx(player, relayer, { kind: "cancel-offer", offer: key(), request: null, owner: player });
    expect(ix.keys.at(-1)).toEqual({ pubkey: protectionsPda(accountOf(player)), isSigner: false, isWritable: true });
    const plan = planTransaction([ix], { relayer, player, isGame: () => false });
    expect(plan).toMatchObject({ names: ["cancel_offer"], class: "exit", playerSigns: true });
  });
});

describe("a Break or Self-Exclusion started while the Player sits in a boarding Railcar car (Q40 review #2)", () => {
  // Ana boarded for 100 and the countdown runs; she Self-Excludes. Her step-off goes first, so it rides with the Self-Exclusion.
  const ana = player;
  const seat = { index: 3, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: accountOf(ana), funder: accountOf(ana), pot: key(), signer: key() };
  const boarding = { loaded: {} as BoardingSeat["loaded"], seat };
  // Her funder's basket and spill and the book of her one Source, as `stepOffFor` passes them.
  const stepOff = () => toWeb3(stepOffIx({ caller: ana, car: key(), seat, markPayer: relayer, potPayer: relayer, sponsor: true, remaining: [key(), key(), key()].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })) }));

  it("puts the step-off before every other clean-up step", () => {
    const order = cleanupOrder([boarding], [{ kind: "cancel-request", request: key(), owner: ana }]);
    expect(order.map((s) => s.kind)).toEqual(["step-off", "cancel-request"]);
  });

  it("the Self-Exclusion and her step-off fit one sponsored transaction, which the sponsor pays", async () => {
    const excl = toWeb3(await coreIx("set_self_exclusion", [6], { ownerAuthority: ana }));
    const ixs = [stepOff(), await refund()];
    expect(stepsThatFit(relayer, [excl], ixs)).toBeGreaterThanOrEqual(1);
    expect(planTransaction([excl, ixs[0]], { relayer, player: ana, isGame: () => false })).toMatchObject({ names: ["set_self_exclusion", "step_off_many_seat_match"], class: "exit" });
  });

  it("sends the step-off in the Self-Exclusion's own transaction, and if that bundle fails, right after the Self-Exclusion alone", async () => {
    const items = ["step-off", "cancel-request"];
    const sent: string[][] = [];
    const ok = await sendAwayBundles(items, { fit: async (_, rest) => rest.length, send: async (lead, batch) => (sent.push([...(lead ? ["set_self_exclusion"] : []), ...batch]), "sig") });
    expect([sent, ok]).toEqual([[["set_self_exclusion", "step-off", "cancel-request"]], { signature: "sig", cleaned: 2, failed: 0, failedItems: [] }]);

    const retried: string[][] = [];
    let first = true;
    const r = await sendAwayBundles(items, {
      fit: async (lead, rest) => (lead ? rest.length : 1),
      send: async (lead, batch) => {
        if (first && batch.length) {
          first = false;
          throw new Error("an item moved");
        }
        retried.push([...(lead ? ["set_self_exclusion"] : []), ...batch]);
        return "sig";
      },
    });
    expect(retried).toEqual([["set_self_exclusion"], ["step-off"], ["cancel-request"]]);
    expect(r).toEqual({ signature: "sig", cleaned: 2, failed: 0, failedItems: [] });
  });

  it("a step-off that cannot even be built (its car unreadable) never blocks the Self-Exclusion: it goes out alone and the step-off counts as failed", async () => {
    const sent: string[][] = [];
    const r = await sendAwayBundles(["step-off", "cancel-request"], {
      fit: async (_, rest) => {
        if (rest[0] === "step-off") throw new Error("car unreadable");
        return rest.length;
      },
      send: async (lead, batch) => (sent.push([...(lead ? ["set_self_exclusion"] : []), ...batch]), "sig"),
    });
    expect(sent).toEqual([["set_self_exclusion"], ["cancel-request"]]);
    expect(r).toEqual({ signature: "sig", cleaned: 1, failed: 1, failedItems: ["step-off"] });
  });

  it("once the Break has landed nothing throws: a later bundle that cannot be built or sent is counted, not reported as an error", async () => {
    let calls = 0;
    const r = await sendAwayBundles(["a", "b", "c"], {
      fit: async (lead, rest) => {
        if (!lead && rest[0] === "b") throw new Error("read failed");
        return lead ? 1 : 1;
      },
      send: async (_lead, batch) => {
        calls++;
        if (batch[0] === "c") throw new Error("moved");
        return "sig";
      },
    });
    expect(calls).toBe(2);
    expect(r).toEqual({ signature: "sig", cleaned: 1, failed: 2, failedItems: ["b", "c"] });
  });

  it("the Player is told they are still in the car when a step-off failed or their boarding car could not be read", () => {
    const off = { kind: "step-off" as const, ...boarding };
    expect(stillBoarding({ seatsRead: true, failedItems: [] })).toBeNull();
    expect(stillBoarding({ seatsRead: true, failedItems: [off] })).toBe("yes");
    expect(stillBoarding({ seatsRead: true, failedItems: [{ kind: "cancel-request", request: key(), owner: ana }] })).toBeNull();
    expect(stillBoarding({ seatsRead: false, failedItems: [] })).toBe("maybe");
  });
});
