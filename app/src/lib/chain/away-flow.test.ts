import { TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { accountOf, coreIx, key, playerIx } from "@/server/sponsor/fixtures";
import { MAX_CLEANUP, planTransaction } from "@/server/sponsor/rules";
import { awayStepIx, stepsThatFit } from "./away-flow";
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
    expect(stepsThatFit(relayer, [player], lead, steps)).toBe(MAX_CLEANUP);
  });
  it("refunds are big: the packed prefix still fits one transaction and one more would not (or hit the limit)", async () => {
    const lead = [toWeb3(await coreIx("set_break", [3], { ownerAuthority: player }))];
    const steps = await Promise.all(Array.from({ length: 8 }, refund));
    const n = stepsThatFit(relayer, [player], lead, steps);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(MAX_CLEANUP);
  });
  it("always takes at least one step so a plan can make progress, and none from an empty list", async () => {
    expect(stepsThatFit(relayer, [player], [], [])).toBe(0);
    const steps = [await refund()];
    expect(stepsThatFit(relayer, [player], [], steps)).toBe(1);
  });
});

describe("the clean-up's released Offer", () => {
  // The W3 core gives an Offer's Entry Limit count back and needs the Backer's Protections for it; main's core leaves a
  // trailing account alone.
  it("carries the Backer's Protections, writable, and the sponsor pays for it", async () => {
    const ix = await awayStepIx(player, relayer, { kind: "cancel-offer", offer: key(), request: null, owner: player });
    expect(ix.keys.at(-1)).toEqual({ pubkey: protectionsPda(accountOf(player)), isSigner: false, isWritable: true });
    const plan = planTransaction([ix], { relayer, player, isGame: () => false });
    expect(plan).toMatchObject({ names: ["cancel_offer"], class: "exit", playerSigns: true });
  });
});
