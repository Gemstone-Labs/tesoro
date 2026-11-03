import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import type { RawTx } from "../history/webhook";

/** Builders for synthetic tesoro_core transactions in the webhook's shape, for tests. */
const idl = coreIdl as unknown as { address: string; instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[]; events: { name: string; discriminator: number[] }[] };
export const CORE = idl.address;
export const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], new PublicKey(CORE))[0].toBase58();
const EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

/** A deterministic key: the same `n` is the same key. */
export const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();

export const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
export const i64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};

export interface Ix {
  program: string;
  accounts: string[];
  data: Buffer;
  /** Instructions this one ran. */
  inner?: Ix[];
}

/** A core instruction with the named accounts in IDL order; accounts not named get a filler key. */
export function coreIx(name: string, accounts: Record<string, string>, args: Buffer = Buffer.alloc(0), inner: Ix[] = []): Ix {
  const def = idl.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`no core instruction ${name}`);
  return { program: CORE, accounts: def.accounts.map((a, i) => accounts[a.name] ?? key(200 + i)), data: Buffer.concat([Buffer.from(def.discriminator), args]), inner };
}

/** The self-call that carries a core event (Anchor event-CPI). `fields` are already Borsh-encoded. */
export function coreEvent(name: string, fields: Buffer): Ix {
  const def = idl.events.find((e) => e.name === name);
  if (!def) throw new Error(`no core event ${name}`);
  return { program: CORE, accounts: [EVENT_AUTHORITY], data: Buffer.concat([EVENT_TAG, Buffer.from(def.discriminator), fields]) };
}

export function rawTx(signature: string, ixs: Ix[], over: { blockTime?: number; slot?: number } = {}): RawTx {
  const keys: string[] = [];
  const at = (k: string) => {
    const i = keys.indexOf(k);
    if (i >= 0) return i;
    keys.push(k);
    return keys.length - 1;
  };
  const enc = (ix: Ix) => ({ programIdIndex: at(ix.program), accounts: ix.accounts.map(at), data: bs58.encode(ix.data) });
  const instructions = ixs.map(enc);
  const innerInstructions = ixs.flatMap((ix, index) => (ix.inner?.length ? [{ index, instructions: ix.inner.map(enc) }] : []));
  return {
    slot: over.slot ?? 100,
    blockTime: over.blockTime ?? 1_800_000_000,
    meta: { err: null, innerInstructions, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [signature], message: { accountKeys: keys, instructions } },
  };
}

const pk = (k: string) => new PublicKey(k).toBuffer();
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};

/** A MatchRunStarted event. `kind`: 0 win, 1 no-show, 2 draw, 3 cancelled, 4 abandoned, 5 game upgraded, 6 refunded by game. */
export function matchRunStarted(m: { opener: string; n: number; game: string; kind: number; winner?: 0 | 1; entry: number; fees?: [number, number, number]; a: string; b: string | null }): Ix {
  const fees = m.fees ?? [0, 0, 0];
  return coreEvent(
    "MatchRunStarted",
    Buffer.concat([
      pk(m.opener), u64(m.n), pk(m.game), Buffer.from([m.kind, m.winner ?? 255]), u64(m.entry), ...fees.map(u64),
      pk(m.a), pk(m.a), pk(m.b ?? PublicKey.default.toBase58()), pk(m.b ?? PublicKey.default.toBase58()),
      Buffer.from([0, 0]), i64(0), i64(0), u16(0), u16(0),
    ]),
  );
}

/** A YieldApplied event. */
export const yieldApplied = (position: string, seq: number, debtGemas: number) => coreEvent("YieldApplied", Buffer.concat([pk(position), u64(seq), u64(0), u64(debtGemas)]));
