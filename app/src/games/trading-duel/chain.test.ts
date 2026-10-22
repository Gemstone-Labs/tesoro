import { matchPda } from "../../lib/chain/basket";
import { describe, expect, it } from "vitest";
import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import duelIdl from "../../lib/chain/idl/trading_duel.json";
import { ASSETS, TRADING_DUEL_PROGRAM_ID, TradingDuelChain, addresses, keypairSigner } from "./chain";
import { NO_PICK } from "./grid";

/** The instructions the client would send to the rollup, captured instead of sent. */
function capture() {
  const chain = new TradingDuelChain(duelIdl, coreIdl);
  const sent: { step: string; ix: TransactionInstruction }[] = [];
  (chain as unknown as { sendTee: (step: string, ixs: TransactionInstruction[]) => Promise<string> }).sendTee = async (step, ixs) => {
    sent.push({ step, ix: ixs[ixs.length - 1] });
    return "sig";
  };
  return { chain, sent, player: keypairSigner(Keypair.generate()) };
}

const keys = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());
const ID = matchPda(Keypair.generate().publicKey, 7n);

describe("rollup instructions", () => {
  it("tick takes caller, duel, both Books and the price feed; end_match the same without the feed", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.tick(player, ID, ASSETS[1]);
    await chain.end(player, ID);
    for (const s of sent) expect(s.ix.programId.equals(TRADING_DUEL_PROGRAM_ID)).toBe(true);
    const base = [player.publicKey, ad.duel, ad.book0, ad.book1].map((k) => k.toBase58());
    expect(keys(sent[0].ix)).toEqual([...base, ASSETS[1].feed.toBase58()]);
    expect(keys(sent[1].ix)).toEqual(base);
    expect(sent.map((s) => s.step)).toEqual(["tick", "end_match"]);
    expect(sent[0].ix.keys[0].isSigner).toBe(true);
    expect(sent[0].ix.keys[1].isWritable).toBe(true);
  });

  it("set_pick takes the Player, the Duel and their own Book, with the column and band as data", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.setPick(player, ID, 1, 7, 3);
    await chain.setPick(player, ID, 0, 11, NO_PICK);
    expect(keys(sent[0].ix)).toEqual([player.publicKey, ad.duel, ad.book1].map((k) => k.toBase58()));
    expect(keys(sent[1].ix)[2]).toBe(ad.book0.toBase58());
    expect([...sent[0].ix.data.subarray(8)]).toEqual([7, 3, 0]);
    expect([...sent[1].ix.data.subarray(8)]).toEqual([11, 0, 128]);
  });

  it("the start passes the asset's price feed after the permission accounts", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.start(player, ID, ASSETS[2]);
    const k = keys(sent[0].ix);
    expect(k).toHaveLength(11);
    expect(k[10]).toBe(ASSETS[2].feed.toBase58());
    expect(k[4]).toBe(permissionPdaFromAccount(ad.duel).toBase58());
  });
});
