import { matchPda } from "../../lib/chain/basket";
import { ComputeBudgetProgram, Keypair, Message, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { describe, expect, it } from "vitest";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import vanguardIdl from "../../lib/chain/idl/vanguard.json";
import { CU, TABLE_PHASE, SLOT, VANGUARD_PROGRAM_ID, VanguardChain, addresses, armyPda, assignmentPda, battlePda, canFinalizeTable, decodeAssignment, keypairSigner, slotOf, tableOf, tablePda, type Assignment, type TableRef, type TableState } from "./chain";

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
const MATCH = matchPda(Keypair.generate().publicKey, 7n);
/** The table the Match is assigned to. */
const ID: TableRef = { generation: 0, index: 3 };

describe("addresses", () => {
  it("derives the Battle and both Armies from the table, and everything else from the program", () => {
    const a = addresses(ID);
    expect(new Set([a.table, a.battle, a.army0, a.army1, a.authority, a.config, a.tables, a.sponsor].map((k) => k.toBase58())).size).toBe(8);
    expect(a.table.equals(tablePda(0, 3))).toBe(true);
    expect(a.battle.equals(battlePda(a.table))).toBe(true);
    expect(a.army1.equals(armyPda(a.table, 1))).toBe(true);
    expect(addresses({ generation: 0, index: 4 }).battle.equals(a.battle)).toBe(false);
    expect(addresses({ generation: 1, index: 3 }).army0.equals(a.army0)).toBe(false);
  });

  it("has no Secret: nothing hidden is shared between the Players", () => {
    expect("secret" in addresses(ID)).toBe(false);
  });
});

describe("rollup instructions", () => {
  it("a declared move takes the Player, the table (read only) and the Battle (no Army), with a compute limit first", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.movePiece(player, ID, 41, 53, { expectedSeq: 0, sealedSwitch: 0 });
    const [limit, ix] = sent[0].ixs;
    expect(limit.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(units(limit)).toBe(CU.declare);
    expect(ix.programId.equals(VANGUARD_PROGRAM_ID)).toBe(true);
    expect(keys(ix)).toEqual([player.publicKey, ad.table, ad.battle].map((k) => k.toBase58()));
    expect([...ix.data.subarray(8)]).toEqual([41, 53, 0, 0, 0, 0, 0]);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(sent[0].step).toBe("move_piece");
  });

  it("a move carries the seq it was built for and the sealed switch byte, little endian", async () => {
    const { chain, sent, player } = capture();
    await chain.movePiece(player, ID, 41, 53, { expectedSeq: 0x01020304, sealedSwitch: 0xab });
    expect([...sent[0].ixs[1].data.subarray(8)]).toEqual([41, 53, 4, 3, 2, 1, 0xab]);
  });

  it.each([
    ["blast", (c: VanguardChain, p: ReturnType<typeof keypairSigner>) => c.blast(p, ID, 33, { expectedSeq: 9, sealedSwitch: 0x5c }), [33, 9, 0, 0, 0, 0x5c]],
    ["rescue", (c: VanguardChain, p: ReturnType<typeof keypairSigner>) => c.rescue(p, ID, 44, { expectedSeq: 9, sealedSwitch: 0x5c }), [44, 9, 0, 0, 0, 0x5c]],
    ["pass", (c: VanguardChain, p: ReturnType<typeof keypairSigner>) => c.pass(p, ID, { expectedSeq: 9, sealedSlot: 0x7e, sealedSwitch: 0x5c }), [9, 0, 0, 0, 0x7e, 0x5c]],
  ] as const)("%s is a declare on the Player, the table and the Battle, within the declare budget", async (step, send, args) => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await send(chain, player);
    const [limit, ix] = sent[0].ixs;
    expect(units(limit)).toBe(CU.declare);
    expect(keys(ix)).toEqual([player.publicKey, ad.table, ad.battle].map((k) => k.toBase58()));
    expect([...ix.data.subarray(8)]).toEqual(args);
    expect(ix.keys[0].isSigner && ix.keys[2].isWritable).toBe(true);
    expect(sent[0].step).toBe(step);
  });

  it("the instruction discriminators are the ones in the program's IDL", async () => {
    const { chain, sent, player } = capture();
    await chain.blast(player, ID, 1, { expectedSeq: 0, sealedSwitch: 0 });
    await chain.rescue(player, ID, 1, { expectedSeq: 0, sealedSwitch: 0 });
    await chain.pass(player, ID, { expectedSeq: 0, sealedSlot: 0, sealedSwitch: 0 });
    const want = (name: string) => Buffer.from((vanguardIdl.instructions.find((i) => i.name === name) as { discriminator: number[] }).discriminator);
    expect(sent.map((s) => Buffer.from(s.ixs[1].data.subarray(0, 8)))).toEqual([want("blast"), want("rescue"), want("pass")]);
  });

  it("resolve takes no arguments: the caller, the table, the Battle and both Armies", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.resolve(player, ID);
    const [limit, ix] = sent[0].ixs;
    expect(units(limit)).toBe(CU.resolve);
    expect(CU.resolve).toBeGreaterThan(60_000);
    expect(keys(ix)).toEqual([player.publicKey, ad.table, ad.battle, ad.army0, ad.army1].map((k) => k.toBase58()));
    expect(ix.data.length).toBe(8);
    expect(ix.keys.slice(1).every((k) => k.isWritable)).toBe(true);
    expect(sent[0].step).toBe("resolve");
  });

  it("a timeout claim names the caller, the table, the Battle and both Armies (read only: the setup phase needs to know who contributed)", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.claimTimeout(player, ID);
    expect(units(sent[0].ixs[0])).toBe(CU.declare);
    const ix = sent[0].ixs[1];
    expect(keys(ix)).toEqual([player.publicKey, ad.table, ad.battle, ad.army0, ad.army1].map((k) => k.toBase58()));
    expect(ix.keys[3].isWritable || ix.keys[4].isWritable).toBe(false);
  });

  it("the Two-Step Turn takes the Player, the table and the Battle", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.startTwoStep(player, ID);
    expect(keys(sent[0].ixs.at(-1)!)).toEqual([player.publicKey, ad.table, ad.battle].map((k) => k.toBase58()));
  });

  it("handing the seats over and wiping them make permissions for both Armies only", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    await chain.seatPlayers(player, ID);
    await chain.wipeSeats(player, ID);
    for (const s of sent) {
      const k = keys(s.ixs.at(-1)!);
      for (const a of [ad.army0, ad.army1]) expect(k).toContain(permissionPdaFromAccount(a).toBase58());
      expect(k).not.toContain(permissionPdaFromAccount(ad.battle).toBase58());
    }
    expect(sent.map((s) => s.step)).toEqual(["seat_players", "wipe_seats"]);
  });

  it("a commit names the table and its Battle and never an Army", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    Object.assign(chain as unknown as Record<string, unknown>, { readConfig: async () => ({ teeValidator: Keypair.generate().publicKey, oracleQueue: Keypair.generate().publicKey }) });
    await chain.commitTable(player, ID);
    const k = keys(sent[0].ixs.at(-1)!);
    expect(k).toContain(ad.table.toBase58());
    expect(k).toContain(ad.battle.toBase58());
    expect(k).not.toContain(ad.army0.toBase58());
    expect(k).not.toContain(ad.army1.toBase58());
  });

  it("entropy goes into the Player's own Army only, is a fresh 32-byte secret each time, and the second contributor also asks for randomness", async () => {
    const { chain, sent, player } = capture();
    const ad = addresses(ID);
    Object.assign(chain as unknown as Record<string, unknown>, { readConfig: async () => ({ teeValidator: Keypair.generate().publicKey, oracleQueue: Keypair.generate().publicKey }) });
    await chain.contributeEntropy(player, ID, 1, false);
    await chain.contributeEntropy(player, ID, 0, true);
    expect(sent[0].ixs).toHaveLength(1);
    expect(sent[1].ixs).toHaveLength(2);
    expect(sent[0].ixs[0].data.subarray(8).length).toBe(32);
    expect(Buffer.compare(sent[0].ixs[0].data, sent[1].ixs[0].data)).not.toBe(0);
    expect(keys(sent[0].ixs[0])).toEqual([player.publicKey, ad.table, ad.battle, ad.army1].map((k) => k.toBase58()));
    expect(keys(sent[1].ixs[0]).at(-1)).toBe(ad.army0.toBase58());
    // only the Army is writable, and the signer is not paying
    expect(sent[0].ixs[0].keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())).toEqual([ad.army1.toBase58()]);
  });
});

describe("deployment values come from the program's own config", () => {
  const validator = Keypair.generate().publicKey;
  const queue = Keypair.generate().publicKey;
  const withConfig = () => {
    const c = capture();
    Object.assign(c.chain as unknown as Record<string, unknown>, { readConfig: async () => ({ teeValidator: validator, oracleQueue: queue }) });
    return c;
  };

  it("the commit pays the fee into the vault of the validator in VanguardConfig", async () => {
    const { chain, sent, player } = withConfig();
    await chain.commitTable(player, ID);
    const vault = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), validator.toBuffer()], DELEGATION_PROGRAM_ID)[0];
    expect(keys(sent[0].ixs.at(-1)!)).toContain(vault.toBase58());
  });

  it("the randomness request names the oracle queue in VanguardConfig", async () => {
    const { chain, sent, player } = withConfig();
    await chain.requestVrf(player, ID);
    expect(keys(sent[0].ixs[0])).toContain(queue.toBase58());
  });

  it("the second contributor's bundled request does too, and the Battle's own queue wins when given", async () => {
    const { chain, sent, player } = withConfig();
    await chain.contributeEntropy(player, ID, 1, true);
    expect(keys(sent[0].ixs[1])).toContain(queue.toBase58());
    const own = Keypair.generate().publicKey;
    await chain.requestVrf(player, ID, own);
    expect(keys(sent[1].ixs[0])).toContain(own.toBase58());
    expect(keys(sent[1].ixs[0])).not.toContain(queue.toBase58());
  });

  it("the request takes no argument: the program chooses the input, once per Match", async () => {
    const { chain, sent, player } = withConfig();
    await chain.requestVrf(player, ID);
    expect(sent[0].ixs[0].data.length).toBe(8);
  });
});

describe("tables and Assignments", () => {
  const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
  const asg = (over: Partial<Assignment> = {}): Assignment => ({ address: assignmentPda(MATCH), tesoroMatch: MATCH, generation: 0, index: 3, epoch: 4, players: [key(1), key(2)], startDeadline: 1300, payer: key(3), ...over });
  const table = (over: Partial<TableState> = {}): TableState => ({
    address: tablePda(0, 3),
    generation: 0,
    index: 3,
    epoch: 4,
    phase: TABLE_PHASE.over,
    seatsCreated: true,
    seatsOpen: false,
    dirty: false,
    tesoroMatch: MATCH,
    slot: 0,
    startDeadline: 1300,
    checkedIn: [true, true],
    overAt: 0,
    reqNonce: 0,
    reqPending: false,
    reqMade: true,
    vrfReady: false,
    ring: [],
    ...over,
  });
  const done = (over = {}) => ({ state: SLOT.done, tesoroMatch: MATCH, epoch: 4, outcome: 1, at: 100, ...over });

  it("an Assignment is the write-once binding of the Match to a table and an epoch", () => {
    const a = asg();
    expect(a.address.equals(assignmentPda(MATCH))).toBe(true);
    expect(assignmentPda(MATCH).equals(assignmentPda(matchPda(Keypair.generate().publicKey, 7n)))).toBe(false);
    const decoded = decodeAssignment(a.address, { tesoroMatch: MATCH, generation: 0, index: 3, epoch: { toNumber: () => 4 }, players: [key(1), key(2)], startDeadline: { toNumber: () => 1300 }, payer: key(3) });
    expect(decoded).toEqual(a);
  });

  it("base settles from the ring only: a Done slot of this Match and epoch, or a table that moved past the epoch", () => {
    const a = asg();
    expect(canFinalizeTable(table({ ring: [done()] }), a, 0)).toBe(true);
    expect(canFinalizeTable(table({ ring: [done({ state: SLOT.reserved })] }), a, 0)).toBe(false);
    expect(canFinalizeTable(table({ ring: [done({ epoch: 3 })] }), a, 0)).toBe(false);
    expect(canFinalizeTable(table({ ring: [done({ tesoroMatch: key(9) })] }), a, 0)).toBe(false);
    // a Match that never ran: only once the table is past its epoch and the start deadline has passed
    expect(canFinalizeTable(table({ epoch: 5 }), a, 1301)).toBe(true);
    expect(canFinalizeTable(table({ epoch: 5 }), a, 1300)).toBe(false);
    expect(canFinalizeTable(table({ epoch: 4 }), a, 5000)).toBe(false);
  });

  it("the table runs the Assignment's Match only at its epoch with its key", () => {
    expect(tableOf(asg(), table())).toBe(true);
    expect(tableOf(asg(), table({ epoch: 5 }))).toBe(false);
    expect(tableOf(asg(), table({ tesoroMatch: key(7) }))).toBe(false);
    expect(slotOf(table({ ring: [done()] }), MATCH, 4)?.outcome).toBe(1);
    expect(slotOf(table({ ring: [done()] }), MATCH, 5)).toBeNull();
  });

  it("finalize reads the committed table and the Assignment, and nothing else of the Game", async () => {
    const { chain, sent, player } = capture();
    Object.assign(chain as unknown as Record<string, unknown>, { readTesoroMatch: async () => ({ inner: { stage: { active: {} } } }) });
    await chain.finalize(player, asg());
    const k = keys(sent[0].ixs.at(-1)!);
    expect(k).toContain(tablePda(0, 3).toBase58());
    expect(k).toContain(assignmentPda(MATCH).toBase58());
    expect(k).not.toContain(battlePda(tablePda(0, 3)).toBase58());
    expect(sent[0].step).toBe("finalize");
  });

  it("assigning is the operator's base-layer call and begins no Match on its own", async () => {
    const { chain, sent, player } = capture();
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    await chain.assignMatch(player, MATCH, a, b, 0, 3, 4);
    const ix = sent[0].ixs.at(-1)!;
    expect(ix.programId.equals(VANGUARD_PROGRAM_ID)).toBe(true);
    expect(keys(ix)).toContain(assignmentPda(MATCH).toBase58());
    expect(sent[0].step).toBe("assign_match");
  });
});

describe("rollup sending", () => {
  /** A fake rollup that hands out `hashes` in turn (the last one repeats) and records each transaction it is sent. */
  function rollup(hashes: string[]) {
    const chain = new VanguardChain(vanguardIdl, coreIdl);
    const messages: string[] = [];
    let n = 0;
    const conn = {
      getLatestBlockhash: async () => ({ blockhash: hashes[Math.min(n++, hashes.length - 1)], lastValidBlockHeight: 1 }),
      sendRawTransaction: async (raw: Buffer) => {
        messages.push(Transaction.from(raw).serializeMessage().toString("base64"));
        return `sig${messages.length}`;
      },
      getSignatureStatuses: async () => ({ value: [{ err: null }] }),
    };
    Object.assign(chain as unknown as Record<string, unknown>, { teeConnection: async () => conn });
    return { chain, messages, player: keypairSigner(Keypair.generate()) };
  }
  const hash = () => Keypair.generate().publicKey.toBase58();
  const hashOf = (m: string) => Message.from(Buffer.from(m, "base64")).recentBlockhash;

  it("never sends the same bytes twice: a second resolve gets a fresh blockhash (identical bytes would reuse the first signature and do nothing)", async () => {
    const [a, b] = [hash(), hash()];
    const { chain, messages, player } = rollup([a, b]);
    await chain.resolve(player, ID);
    await chain.resolve(player, ID);
    expect(messages).toHaveLength(2);
    expect(new Set(messages).size).toBe(2);
  });

  it("keeps asking while the rollup still hands out the blockhash the same bytes were sent with", async () => {
    const [a, b] = [hash(), hash()];
    const { chain, messages, player } = rollup([a, a, a, b]);
    await chain.claimTimeout(player, ID);
    await chain.claimTimeout(player, ID);
    expect(messages.map(hashOf)).toEqual([a, b]);
  });

  it("different actions still share one cached blockhash (no extra round trip in a turn)", async () => {
    const [a, b] = [hash(), hash()];
    const { chain, messages, player } = rollup([a, b]);
    await chain.resolve(player, ID);
    await chain.claimTimeout(player, ID);
    expect(messages.map(hashOf)).toEqual([a, a]);
  });
});
