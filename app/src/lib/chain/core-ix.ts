import "./polyfill";
import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import coreIdl from "./idl/tesoro_core.json";

/**
 * Builds a program's instructions from its IDL, so the account order, the writable and signer flags and the
 * argument encoding can never drift from the program: the name list is the IDL's, a missing account is an error,
 * an optional account left out stands for `None` (the program id). Remaining accounts follow, as given.
 */
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

export type AccountsByName = Record<string, PublicKey | null | undefined>;

/** The Anchor coder wants BN for 64-bit and wider integers. */
const bn = (v: unknown): any => {
  if (typeof v === "bigint") return new BN(v.toString());
  if (Array.isArray(v)) return v.map(bn);
  if (v && typeof v === "object" && !(v instanceof PublicKey) && !(v instanceof BN) && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bn(x)]));
  return v;
};

export type IxBuilder = (name: string, accounts: AccountsByName, args?: Record<string, unknown>, remaining?: AccountMeta[]) => TransactionInstruction;

/** An instruction builder for the program of `json` (an Anchor IDL with its `address`). */
export function idlIxBuilder(json: { address: string; instructions: unknown[] }): { build: IxBuilder; programId: PublicKey; nameOf(data: Uint8Array): string | null } {
  const coder = new BorshInstructionCoder(json as unknown as Idl);
  const programId = new PublicKey(json.address);
  const ixs = new Map((json.instructions as IdlIx[]).map((i) => [i.name, i]));
  const label = (json as { metadata?: { name?: string } }).metadata?.name ?? programId.toBase58();
  const build: IxBuilder = (name, accounts, args = {}, remaining = []) => {
    const spec = ixs.get(name);
    if (!spec) throw new Error(`${label} has no instruction ${name}`);
    const known = new Set(spec.accounts.map((a) => a.name));
    for (const k of Object.keys(accounts)) if (!known.has(k)) throw new Error(`${name} has no account ${k}`);
    const keys: AccountMeta[] = spec.accounts.map((a) => {
      const given = accounts[a.name];
      const pubkey = given ?? (a.address ? new PublicKey(a.address) : a.optional ? programId : null);
      if (!pubkey) throw new Error(`${name}: account ${a.name} is missing`);
      const none = given == null && a.optional;
      return { pubkey, isSigner: !none && !!a.signer, isWritable: !none && !!a.writable };
    });
    return new TransactionInstruction({ programId, keys: [...keys, ...remaining], data: coder.encode(name, bn(args)) });
  };
  return { build, programId, nameOf: (data) => coder.decode(Buffer.from(data))?.name ?? null };
}

const core = idlIxBuilder(coreIdl as { address: string; instructions: unknown[] });
export const CORE_PROGRAM_ID = core.programId;
export const coreIx: IxBuilder = core.build;

export const metaOf = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });

export const coreIxName = (ix: Pick<TransactionInstruction, "programId" | "data">): string | null => (ix.programId.equals(CORE_PROGRAM_ID) ? core.nameOf(ix.data) : null);
