import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as ix from "./core-ix.ts";
import { loadIdl } from "./runtime.ts";
import { CORE_ID, basketOf, eventAuthority, spillOf } from "./kit.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const names = (i: { keys: { pubkey: PublicKey }[] }) => i.keys.map((x) => x.pubkey.toBase58());
const has = (i: { keys: { pubkey: PublicKey }[] }, key: PublicKey) => names(i).includes(key.toBase58());

// Every builder must produce an instruction the IDL accepts: a renamed or added account fails here, not on the chain.
describe("core instruction builders", () => {
  it("match_chunk carries the event authority and the remaining accounts, and the stores resolve from the Account", async () => {
    const [caller, matchState, potA, potB, extra] = [k(), k(), k(), k(), k()];
    const i = await ix.matchChunkIx(core, { caller, matchState, potA, potB, steps: 4, remaining: [ix.meta(extra)] });
    assert.ok(has(i, eventAuthority) && has(i, extra) && has(i, potB));
    assert.equal(i.programId.toBase58(), CORE_ID.toBase58());
    const solo = await ix.matchChunkIx(core, { caller, matchState, potA, steps: 1, remaining: [] });
    assert.equal(solo.keys.length, 6, "caller, match, pot A, an absent pot B, event authority, program");
  });
  it("close_match, refund_match and the store growth build", async () => {
    const [caller, matchState, payer, potA, game] = [k(), k(), k(), k(), k()];
    await ix.closeMatchIx(core, { caller, matchState, matchPayer: payer, potA, potAPayer: payer, remaining: [] });
    const r = await ix.refundMatchIx(core, { caller, payer, game, matchState });
    assert.ok(has(r, eventAuthority));
    const account = k();
    const g = await ix.growStoreIx(core, { payer, account, which: "spill", extra: 3 });
    assert.ok(has(g, spillOf(account)) && has(g, basketOf(account)));
    await ix.claimSpillIx(core, { account, max: 4 });
  });
  it("Ticket and Instant Redeem upkeep builds", async () => {
    const [caller, owner, ticket, payer, order, wallet] = [k(), k(), k(), k(), k(), k()];
    await ix.cancelTicketIx(core, { signer: caller, owner, ticket, maxLines: 8 });
    await ix.closeTicketIx(core, { caller, ticket, payer });
    await ix.expireInstantRedeemIx(core, { signer: caller, ownerAccount: owner, order, ownerWallet: wallet });
    await ix.closeReceiptIx(core, { caller, receipt: k(), payer });
    await ix.closePairIx(core, { caller, opener: owner, joiner: k(), pair: k(), payer });
    await ix.fillInstantRedeemIx(core, { filler: caller, order, ownerWallet: wallet, position: k(), source: k(), gemas: 5n, remaining: [] });
  });
  it("harvest, fee cash-in, listing and page upkeep builds", async () => {
    const [position, source, recipient] = [k(), k(), k()];
    await ix.harvestIx(core, { position, source, remaining: [] });
    await ix.cashInFeeIx(core, { cls: 0, recipientAccount: recipient, position, source, remaining: [] });
    await ix.refreshListingIx(core, { gameRecord: k(), game: k() });
    await ix.initCkptPageIx(core, { payer: k(), book: k(), page: k(), cls: 1, pageNo: 0 });
    await ix.expireOfferIx(core, { caller: k(), backerAccount: k(), offer: k() });
    await ix.clearRequestIx(core, { caller: k(), request: k(), protections: k() });
  });
  it("Season instructions build", async () => {
    const [authority, poolAccount, winner, prize, season] = [k(), k(), k(), k(), k()];
    await ix.recordSeasonIx(core, { authority, number: 3, points: [50n, 10n], poolAccount, ranked: [k(), k()], routes: [k()] });
    await ix.paySeasonRankIx(core, { authority, season, poolAccount, winnerAccount: winner, prizeSource: prize, rank: 0, line: 0 });
    await ix.closeSeasonIx(core, { season });
    await ix.fundSeasonPrizeNativeIx(core, { authority, season: 3, custody: k(), pool: k(), priceFeed: k(), poolAccount, prizeSource: prize });
    await ix.fundSeasonPrizeStakeIx(core, { authority, season: 3, custody: k(), mint: k(), stakePool: k(), priceFeed: k(), poolAccount, prizeSource: prize });
  });
});
