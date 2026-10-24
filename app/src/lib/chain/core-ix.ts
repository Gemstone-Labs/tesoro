import "./polyfill";
import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import coreIdl from "./idl/tesoro_core.json";

/**
 * Builds tesoro_core instructions from the IDL, so the account order, the writable and signer flags and the
 * argument encoding can never drift from the program: the name list is the IDL's, a missing account is an error,
 * an optional account left out stands for `None` (the program id). Remaining accounts follow, as given.
 */
const IDL = coreIdl as unknown as Idl;
const coder = new BorshInstructionCoder(IDL);
export const CORE_PROGRAM_ID = new PublicKey((coreIdl as { address: string }).address);

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
interface IdlIx {
  name: string;
  accounts: IdlAccount[];
}
const ixs = new Map((coreIdl.instructions as unknown as IdlIx[]).map((i) => [i.name, i]));

export type AccountsByName = Record<string, PublicKey | null | undefined>;

/** The Anchor coder wants BN for 64-bit and wider integers. */
const bn = (v: unknown): any => {
  if (typeof v === "bigint") return new BN(v.toString());
  if (Array.isArray(v)) return v.map(bn);
  if (v && typeof v === "object" && !(v instanceof PublicKey) && !(v instanceof BN) && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bn(x)]));
  return v;
};

export function coreIx(name: string, accounts: AccountsByName, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []): TransactionInstruction {
  const spec = ixs.get(name);
  if (!spec) throw new Error(`tesoro_core has no instruction ${name}`);
  const known = new Set(spec.accounts.map((a) => a.name));
  for (const k of Object.keys(accounts)) if (!known.has(k)) throw new Error(`${name} has no account ${k}`);
  const keys: AccountMeta[] = spec.accounts.map((a) => {
    const given = accounts[a.name];
    const pubkey = given ?? (a.address ? new PublicKey(a.address) : a.optional ? CORE_PROGRAM_ID : null);
    if (!pubkey) throw new Error(`${name}: account ${a.name} is missing`);
    const none = given == null && a.optional;
    return { pubkey, isSigner: !none && !!a.signer, isWritable: !none && !!a.writable };
  });
  return new TransactionInstruction({ programId: CORE_PROGRAM_ID, keys: [...keys, ...remaining], data: coder.encode(name, bn(args)) });
}

export const metaOf = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });

export const coreIxName = (ix: Pick<TransactionInstruction, "programId" | "data">): string | null =>
  ix.programId.equals(CORE_PROGRAM_ID) ? coder.decode(ix.data)?.name ?? null : null;
