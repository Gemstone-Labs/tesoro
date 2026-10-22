import { matchPda } from "../../lib/chain/basket";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import duelIdl from "../../lib/chain/idl/trading_duel.json";
import { ASSETS, TRADING_DUEL_PROGRAM_ID, TradingDuelChain, assignmentPda, bookPda, keypairSigner, sponsorPda, tablePda, type Assignment } from "./chain";
import { NO_PICK } from "./grid";

/** The instructions the client would send, captured instead of sent. */
function capture() {
  const chain = new TradingDuelChain(duelIdl, coreIdl);
  const sent: { step: string; ix: TransactionInstruction }[] = [];
  const grab = async (step: string, ixs: TransactionInstruction[]) => {
    sent.push({ step, ix: ixs[ixs.length - 1] });
    return "sig";
  };
  const hack = chain as unknown as { sendTee: typeof grab; sendBase: typeof grab; readTesoroMatch: () => Promise<unknown> };
  hack.sendTee = grab;
  hack.sendBase = grab;
  hack.readTesoroMatch = async () => ({ inner: { stage: { active: {} } } });
  return { chain, sent, player: keypairSigner(Keypair.generate()) };
}

const keys = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());
const ID = matchPda(Keypair.generate().publicKey, 7n);
const assignment: Assignment = {
  address: assignmentPda(ID),
  tesoroMatch: ID,
  generation: 0,
  index: 2,
  epoch: 4,
  players: [Keypair.generate().publicKey, Keypair.generate().publicKey],
  asset: ASSETS[1],
  startDeadline: 1300,
  payer: Keypair.generate().publicKey,
};
const table = tablePda(0, 2);

describe("table addresses", () => {
  it("a table is the generation and index as little-endian u16, an Assignment is keyed by the Match", () => {
    expect(table.equals(PublicKey.findProgramAddressSync([Buffer.from("table"), Buffer.from([0, 0]), Buffer.from([2, 0])], TRADING_DUEL_PROGRAM_ID)[0])).toBe(true);
    expect(assignmentPda(ID).equals(PublicKey.findProgramAddressSync([Buffer.from("assign"), ID.toBuffer()], TRADING_DUEL_PROGRAM_ID)[0])).toBe(true);
    expect(bookPda(table, 1).equals(bookPda(table, 0))).toBe(false);
  });
});

describe("rollup instructions", () => {
  it("tick takes caller, table, both Books and the price feed; end_match the same without the feed", async () => {
    const { chain, sent, player } = capture();
    await chain.tick(player, assignment, ASSETS[1]);
    await chain.end(player, assignment);
    for (const s of sent) expect(s.ix.programId.equals(TRADING_DUEL_PROGRAM_ID)).toBe(true);
    const base = [player.publicKey, table, bookPda(table, 0), bookPda(table, 1)].map((k) => k.toBase58());
    expect(keys(sent[0].ix)).toEqual([...base, ASSETS[1].feed.toBase58()]);
    expect(keys(sent[1].ix)).toEqual(base);
    expect(sent.map((s) => s.step)).toEqual(["tick", "end_match"]);
    expect(sent[0].ix.keys[0].isSigner).toBe(true);
    expect(sent[0].ix.keys[1].isWritable).toBe(true);
  });

  it("set_pick takes the Player, the table and their own Book, with the column and band as data", async () => {
    const { chain, sent, player } = capture();
    await chain.setPick(player, assignment, 1, 7, 3);
    await chain.setPick(player, assignment, 0, 11, NO_PICK);
    expect(keys(sent[0].ix)).toEqual([player.publicKey, table, bookPda(table, 1)].map((k) => k.toBase58()));
    expect(keys(sent[1].ix)[2]).toBe(bookPda(table, 0).toBase58());
    expect([...sent[0].ix.data.subarray(8)]).toEqual([7, 3, 0]);
    expect([...sent[1].ix.data.subarray(8)]).toEqual([11, 0, 128]);
  });

  it("check_in passes the asset's price feed after the table", async () => {
    const { chain, sent, player } = capture();
    await chain.checkIn(player, assignment, ASSETS[2]);
    expect(keys(sent[0].ix)).toEqual([player.publicKey, table, ASSETS[2].feed].map((k) => k.toBase58()));
  });

  it("begin_match names the Assignment, the table and the core Match", async () => {
    const { chain, sent, player } = capture();
    await chain.beginMatch(player, assignment);
    expect(keys(sent[0].ix)).toEqual([player.publicKey, assignment.address, table, ID].map((k) => k.toBase58()));
  });

  it("open_seats names both Books and their permissions", async () => {
    const { chain, sent, player } = capture();
    await chain.openSeats(player, assignment);
    const k = keys(sent[0].ix);
    expect(k.slice(0, 6)).toEqual(
      [player.publicKey, table, bookPda(table, 0), bookPda(table, 1), permissionPdaFromAccount(bookPda(table, 0)), permissionPdaFromAccount(bookPda(table, 1))].map((x) => x.toBase58()),
    );
    expect(k).toHaveLength(9);
  });

  it("commit_table is paid by the Sponsor and passes the validator's fee vault", async () => {
    const { chain, sent, player } = capture();
    await chain.commitTable(player, assignment);
    const k = keys(sent[0].ix);
    expect(k.slice(0, 3)).toEqual([player.publicKey, table, sponsorPda()].map((x) => x.toBase58()));
    expect(sent[0].ix.keys[2].isWritable).toBe(true);
    expect(k).toHaveLength(6);
  });

  it("the scheduler's instructions take the table and, where they need it, the Match's receipt", async () => {
    const { chain, sent, player } = capture();
    await chain.resetTable(player, table);
    await chain.releaseSlot(player, table, 3, ID);
    await chain.voidTable(player, table, ID);
    expect(sent.map((s) => s.step)).toEqual(["reset_table", "release_slot", "void_table"]);
    expect(keys(sent[0].ix)).toEqual([player.publicKey, table].map((x) => x.toBase58()));
    expect(sent[1].ix.data[8]).toBe(3);
    expect(keys(sent[1].ix)).toContain(ID.toBase58());
  });
});

describe("base layer instructions", () => {
  it("finalize names the Assignment and the table, and sends nothing for a Match that is already settled", async () => {
    const { chain, sent, player } = capture();
    await chain.finalize(player, assignment);
    const k = keys(sent[0].ix);
    expect(k.slice(0, 4)).toEqual([player.publicKey, assignment.address, table, ID].map((x) => x.toBase58()));
    (chain as unknown as { readTesoroMatch: () => Promise<unknown> }).readTesoroMatch = async () => ({ inner: { stage: { closed: {} } } });
    expect(await chain.finalize(player, assignment)).toBe("");
    expect(sent).toHaveLength(1);
  });

  it("assign_match carries generation, index and epoch, signed by the operator", async () => {
    const { chain, sent, player } = capture();
    await chain.assignMatch(player, ID, assignment.players[0], assignment.players[1], 0, 2, 4);
    expect(sent[0].ix.keys[0].pubkey.equals(player.publicKey)).toBe(true);
    expect(sent[0].ix.keys[0].isSigner).toBe(true);
    // generation u16, index u16, epoch u64
    expect([...sent[0].ix.data.subarray(8)]).toEqual([0, 0, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0]);
  });
});
