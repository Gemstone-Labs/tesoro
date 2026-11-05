import "./polyfill";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type AddressLookupTableAccount,
  type MessageV0,
  type TransactionInstruction,
  type VersionedMessage,
} from "@solana/web3.js";
import blockPuzzleIdl from "./idl/block_puzzle.json";
import holdemIdl from "./idl/holdem.json";
import railcarIdl from "./idl/railcar.json";
import coreIdl from "./idl/tesoro_core.json";
import tradingDuelIdl from "./idl/trading_duel.json";
import vanguardIdl from "./idl/vanguard.json";

/**
 * The one size rule for every transaction the app, the sponsor server and the LiteSVM tests send: sized exactly as it
 * goes on the wire (v0 or legacy, every signature, the lookup tables it is compiled with), and refused over the network's
 * limits with an error naming its instructions. web3.js only says "encoding overruns Uint8Array" past the limit.
 */

/** A transaction is at most this many bytes on the wire. */
export const MAX_TX_BYTES = 1232;
/** A transaction locks at most this many accounts. */
export const MAX_TX_ACCOUNTS = 64;

export interface TxSize {
  bytes: number;
  /** Accounts it locks: static keys plus those read through lookup tables. */
  accounts: number;
}

export class TxTooLarge extends Error {
  constructor(
    readonly instructions: string[],
    readonly size: TxSize,
  ) {
    super(`${instructions.join(" + ")}: ${size.bytes} B (limit ${MAX_TX_BYTES}), ${size.accounts} accounts`);
    this.name = "TxTooLarge";
  }
}

const shortVec = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/** Wire size of a compiled message signed by every required signer (web3.js would throw instead of serializing one too big). */
export function messageSize(m: VersionedMessage): TxSize {
  const sigs = m.header.numRequiredSignatures;
  const keys = m.staticAccountKeys.length;
  let bytes = shortVec(sigs) + 64 * sigs + (m.version === 0 ? 1 : 0) + 3 + shortVec(keys) + 32 * keys + 32;
  bytes += shortVec(m.compiledInstructions.length);
  for (const ix of m.compiledInstructions) bytes += 1 + shortVec(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + shortVec(ix.data.length) + ix.data.length;
  let looked = 0;
  if (m.version === 0) {
    bytes += shortVec(m.addressTableLookups.length);
    for (const l of m.addressTableLookups) {
      bytes += 32 + shortVec(l.writableIndexes.length) + l.writableIndexes.length + shortVec(l.readonlyIndexes.length) + l.readonlyIndexes.length;
      looked += l.writableIndexes.length + l.readonlyIndexes.length;
    }
  }
  return { bytes, accounts: keys + looked };
}

const namers = [coreIdl, railcarIdl, blockPuzzleIdl, holdemIdl, tradingDuelIdl, vanguardIdl].map((json) => {
  const idl = json as unknown as Idl & { address: string; metadata: { name: string } };
  return { programId: new PublicKey(idl.address), label: idl.metadata.name, coder: new BorshInstructionCoder(idl) };
});

/** `program.instruction` for the app's programs (from their IDLs), the program otherwise. */
export function instructionName(ix: Pick<TransactionInstruction, "programId" | "data">): string {
  if (ix.programId.equals(ComputeBudgetProgram.programId)) return "compute_budget";
  if (ix.programId.equals(SystemProgram.programId)) return "system";
  const namer = namers.find((n) => n.programId.equals(ix.programId));
  const name = namer ? namer.coder.decode(Buffer.from(ix.data))?.name : null;
  return namer && name ? `${namer.label}.${name}` : `program ${ix.programId.toBase58()}`;
}

/** Throws `TxTooLarge` when the compiled `m` of `ixs` passes a limit. */
export function checkSize(m: VersionedMessage, ixs: Pick<TransactionInstruction, "programId" | "data">[]): void {
  const size = messageSize(m);
  if (size.bytes > MAX_TX_BYTES || size.accounts > MAX_TX_ACCOUNTS) throw new TxTooLarge(ixs.map(instructionName), size);
}

const compile = (payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[], legacy: boolean): VersionedMessage => {
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs });
  return legacy ? m.compileToLegacyMessage() : m.compileToV0Message(tables);
};

/** The v0 message of `ixs`, refused (`TxTooLarge`) when it would not fit. */
export function checkedV0(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[] = []): MessageV0 {
  const m = compile(payer, blockhash, ixs, tables, false) as MessageV0;
  checkSize(m, ixs);
  return m;
}

/** Refuses (`TxTooLarge`) `ixs` sent as a legacy transaction paid by `payer` when they would not fit. */
export function checkLegacy(payer: PublicKey, ixs: TransactionInstruction[]): void {
  checkSize(compile(payer, PublicKey.default.toBase58(), ixs, [], true), ixs);
}

export interface SizeOpts {
  tables?: AddressLookupTableAccount[];
  legacy?: boolean;
}

/** The size `ixs` paid by `payer` take on the wire. */
export const sizeOf = (payer: PublicKey, ixs: TransactionInstruction[], opts: SizeOpts = {}): TxSize => messageSize(compile(payer, PublicKey.default.toBase58(), ixs, opts.tables ?? [], !!opts.legacy));

/** True when `ixs` fit one transaction. */
export function fitsTx(payer: PublicKey, ixs: TransactionInstruction[], opts: SizeOpts = {}): boolean {
  try {
    const s = sizeOf(payer, ixs, opts);
    return s.bytes <= MAX_TX_BYTES && s.accounts <= MAX_TX_ACCOUNTS;
  } catch {
    return false;
  }
}
