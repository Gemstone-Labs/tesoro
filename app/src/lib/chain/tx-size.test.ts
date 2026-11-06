import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { coreIx } from "./core-ix";
import { MAX_TX_BYTES, TxTooLarge, checkedV0, checkLegacy, fitsTx, instructionName, sizeOf } from "./tx-size";

const key = () => Keypair.generate().publicKey;
const BLOCKHASH = PublicKey.default.toBase58();

/** A tesoro_core instruction naming `n` extra writable accounts: big enough to pass the limit when `n` is large. */
const wide = (n: number) => {
  const ix = coreIx("close_receipt", { caller: key(), receipt: key(), payer: key() });
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: [...ix.keys, ...Array.from({ length: n }, () => ({ pubkey: key(), isSigner: false, isWritable: true }))] });
};

/** The bytes web3.js puts on the wire for the same transaction (it refuses to serialize one over the limit). */
const web3Bytes = (payer: PublicKey, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[] = [], legacy = false) => {
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs });
  return new VersionedTransaction(legacy ? m.compileToLegacyMessage() : m.compileToV0Message(tables)).serialize().length;
};

describe("transaction size", () => {
  it("counts the bytes web3.js sends, with every signature, v0 and legacy", () => {
    const payer = key();
    const cosigner = key();
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), SystemProgram.transfer({ fromPubkey: cosigner, toPubkey: key(), lamports: 1 }), wide(10)];
    expect(sizeOf(payer, ixs).bytes).toBe(web3Bytes(payer, ixs));
    expect(sizeOf(payer, ixs, { legacy: true }).bytes).toBe(web3Bytes(payer, ixs, [], true));
    const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: ixs.flatMap((i) => i.keys.filter((k) => !k.isSigner).map((k) => k.pubkey)) } });
    expect(sizeOf(payer, ixs, { tables: [table] }).bytes).toBe(web3Bytes(payer, ixs, [table]));
    expect(sizeOf(payer, ixs, { tables: [table] }).bytes).toBeLessThan(sizeOf(payer, ixs).bytes);
  });

  it("refuses a transaction over 1,232 bytes and names its instructions and size", () => {
    const payer = key();
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), wide(40)];
    const bytes = sizeOf(payer, ixs).bytes;
    expect(bytes).toBeGreaterThan(MAX_TX_BYTES);
    expect(fitsTx(payer, ixs)).toBe(false);
    let err: unknown;
    try {
      checkedV0(payer, BLOCKHASH, ixs);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TxTooLarge);
    expect((err as TxTooLarge).instructions).toEqual(["compute_budget", "tesoro_core.close_receipt"]);
    expect((err as Error).message).toBe(`compute_budget + tesoro_core.close_receipt: ${bytes} B (limit 1232), 46 accounts`);
    expect(() => checkLegacy(payer, ixs)).toThrow(TxTooLarge);
  });

  it("passes a transaction that fits and refuses one locking more than 64 accounts", () => {
    const payer = key();
    expect(checkedV0(payer, BLOCKHASH, [wide(5)]).staticAccountKeys.length).toBe(10);
    const lookups = Array.from({ length: 70 }, () => key());
    const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: lookups } });
    const many = new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.alloc(0), keys: lookups.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })) });
    expect(sizeOf(payer, [many], { tables: [table] }).bytes).toBeLessThan(MAX_TX_BYTES);
    expect(() => checkedV0(payer, BLOCKHASH, [many], [table])).toThrow(/72 accounts/);
  });

  it("names instructions of every program the app builds for, and others by program", () => {
    expect(instructionName(wide(0))).toBe("tesoro_core.close_receipt");
    expect(instructionName(SystemProgram.transfer({ fromPubkey: key(), toPubkey: key(), lamports: 1 }))).toBe("system");
    const other = key();
    expect(instructionName(new TransactionInstruction({ programId: other, data: Buffer.from([1, 2]), keys: [] }))).toBe(`program ${other.toBase58()}`);
  });
});
