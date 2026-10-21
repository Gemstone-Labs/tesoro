import { ComputeBudgetProgram, Keypair, type TransactionInstruction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { describe, expect, it } from "vitest";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import vanguardIdl from "../../lib/chain/idl/vanguard.json";
import { CU, VANGUARD_PROGRAM_ID, VanguardChain, addresses, keypairSigner } from "./chain";
import { gameRecordPda } from "../../lib/chain/game-record";

type Sent = { step: string; ixs: TransactionInstruction[] };

/** The transactions the client would send, captured instead of sent. */
function capture() {
  const chain = new VanguardChain(vanguardIdl, coreIdl);
  const sent: Sent[] = [];
  const grab = async (step: string, ixs: TransactionInstruction[]) => {
    sent.push({ step, ixs });
    return "sig";
  };
  Object.assign(chain as unknown as Record<string, unknown>, { sendTee: grab, sendBase: grab });
  return { chain, sent, player: keypairSigner(Keypair.generate()) };
}

const keys = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());
const units = (ix: TransactionInstruction) => ix.data.readUInt32LE(1);
const ID = 1_800_000_000_000n * 2n + 1n;

describe("addresses", () => {
  it("derives the Battle, Secret and both Armies from the Match id", () => {
    const a = addresses(ID);
    expect(new Set([a.battle, a.secret, a.army0, a.army1, a.authority, a.config].map((k) => k.toBase58())).size).toBe(6);
    expect(addresses(ID + 2n).battle.equals(a.battle)).toBe(false);
  });
});

describe("rollup instructions", () => {
  it("a declared move takes only the Player and the Battle (no Army, no Secret), with a compute limit first", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.movePiece(player, ID, 41, 53);
    const [limit, ix] = sent[0].ixs;
    expect(limit.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(units(limit)).toBe(CU.declare);
    expect(ix.programId.equals(VANGUARD_PROGRAM_ID)).toBe(true);
    expect(keys(ix)).toEqual([player.publicKey, ad.battle].map((k) => k.toBase58()));
    expect([...ix.data.subarray(8)]).toEqual([41, 53]);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(sent[0].step).toBe("move_piece");
  });

  it("resolve takes no arguments: the caller, the Battle, both Armies and the Secret", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.resolve(player, ID);
    const [limit, ix] = sent[0].ixs;
    expect(units(limit)).toBe(CU.resolve);
    expect(CU.resolve).toBeGreaterThan(60_000);
    expect(keys(ix)).toEqual([player.publicKey, ad.battle, ad.army0, ad.army1, ad.secret].map((k) => k.toBase58()));
    expect(ix.data.length).toBe(8);
    expect(ix.keys[1].isWritable && ix.keys[2].isWritable && ix.keys[3].isWritable).toBe(true);
    expect(sent[0].step).toBe("resolve");
  });

  it("a timeout claim names the caller, the Battle and the Secret, and no Army", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.claimTimeout(player, ID);
    expect(units(sent[0].ixs[0])).toBe(CU.declare);
    expect(keys(sent[0].ixs[1])).toEqual([player.publicKey, ad.battle, ad.secret].map((k) => k.toBase58()));
  });

  it("the Two-Step Turn takes only the Player and the Battle", async () => {
    const { chain, sent, player } = capture();
    await chain.startTwoStep(player, ID);
    expect(keys(sent[0].ixs.at(-1)!)).toEqual([player.publicKey, addresses(ID).battle].map((k) => k.toBase58()));
  });

  it("the permissions are created for all four accounts", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.initPermissions(player, ID);
    const k = keys(sent[0].ixs.at(-1)!);
    for (const a of [ad.battle, ad.secret, ad.army0, ad.army1]) expect(k).toContain(permissionPdaFromAccount(a).toBase58());
  });

  it("entropy is a fresh 32-byte secret each time, and the second contributor also asks for randomness", async () => {
    const { chain, sent, player } = capture();
    Object.assign(chain as unknown as Record<string, unknown>, { readConfig: async () => ({ teeValidator: Keypair.generate().publicKey, oracleQueue: Keypair.generate().publicKey }) });
    await chain.contributeEntropy(player, ID, false);
    await chain.contributeEntropy(player, ID, true);
    expect(sent[0].ixs).toHaveLength(1);
    expect(sent[1].ixs).toHaveLength(2);
    expect(sent[0].ixs[0].data.subarray(8).length).toBe(32);
    expect(Buffer.compare(sent[0].ixs[0].data, sent[1].ixs[0].data)).not.toBe(0);
  });

  it("closing the Match closes the permissions and commits back", async () => {
    const { chain, sent, player } = capture();
    const conn = { __tee: true };
    (chain as unknown as { teeConnection: () => Promise<unknown> }).teeConnection = async () => conn;
    await chain.closeMatch(player, ID).catch(() => undefined);
    const k = keys(sent[0].ixs.at(-1)!);
    expect(k).toContain(permissionPdaFromAccount(addresses(ID).battle).toBase58());
    expect(k).toHaveLength(13);
  });
});

describe("deployment values come from the program's own config", () => {
  const validator = Keypair.generate().publicKey;
  const queue = Keypair.generate().publicKey;
  const withConfig = () => {
    const c = capture();
    Object.assign(c.chain as unknown as Record<string, unknown>, {
      readConfig: async () => ({ teeValidator: validator, oracleQueue: queue }),
      waitOwner: async () => true,
      pause: async () => undefined,
    });
    return c;
  };

  it("delegation names the validator in VanguardConfig", async () => {
    const { chain, sent, player } = withConfig();
    await chain.delegateMatch(player, ID);
    expect(keys(sent[0].ixs[1])).toContain(validator.toBase58());
  });

  it("the randomness request names the oracle queue in VanguardConfig", async () => {
    const { chain, sent, player } = withConfig();
    await chain.requestVrf(player, ID);
    expect(keys(sent[0].ixs[0])).toContain(queue.toBase58());
  });

  it("the second contributor's bundled request does too, and the Battle's own queue wins when given", async () => {
    const { chain, sent, player } = withConfig();
    await chain.contributeEntropy(player, ID, true);
    expect(keys(sent[0].ixs[1])).toContain(queue.toBase58());
    const own = Keypair.generate().publicKey;
    await chain.requestVrf(player, ID, own);
    expect(keys(sent[1].ixs[0])).toContain(own.toBase58());
    expect(keys(sent[1].ixs[0])).not.toContain(queue.toBase58());
  });
});

describe("base-layer instructions", () => {
  it("delegating the Match gets the 600k compute limit and names the TEE validator", async () => {
    const { chain, sent, player } = capture();
    (chain as unknown as { waitOwner: () => Promise<boolean> }).waitOwner = async () => true;
    (chain as unknown as { pause: () => Promise<void> }).pause = async () => undefined;
    (chain as unknown as { readConfig: () => Promise<unknown> }).readConfig = async () => ({ teeValidator: Keypair.generate().publicKey, oracleQueue: Keypair.generate().publicKey });
    await chain.delegateMatch(player, ID);
    expect(units(sent[0].ixs[0])).toBe(CU.delegate);
    expect(CU.delegate).toBe(600_000);
    expect(keys(sent[0].ixs[1])).toContain(addresses(ID).battle.toBase58());
  });

  it("create_match binds the Battle to the tesoro_core Match with both Accounts", async () => {
    const { chain, sent, player } = capture();
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    await chain.createMatch(player, ID, a, b);
    const ix = sent[0].ixs[0];
    expect(ix.programId.equals(VANGUARD_PROGRAM_ID)).toBe(true);
    expect(keys(ix)).toContain(addresses(ID).battle.toBase58());
    // The program's own config is passed next to the Game's record in tesoro_core, and they are different accounts.
    expect(keys(ix)).toContain(addresses(ID).config.toBase58());
    expect(keys(ix)).toContain(gameRecordPda(VANGUARD_PROGRAM_ID).toBase58());
    expect(ix.data.readBigUInt64LE(8)).toBe(ID);
  });
});
