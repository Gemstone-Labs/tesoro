import { Keypair, PublicKey } from "@solana/web3.js";
import { DISC, LINE_LEN, POT_AT, STORE_HEADER, type StoreLine } from "./kit.ts";

/** Account bytes of a line store (tests): `bodyAt` is 8 for a basket or spill and `POT_AT` for a Pot. */
export function storeBytes(lines: Partial<StoreLine>[], opts: { account?: PublicKey; capacity?: number; first?: number; roomReserved?: number; bodyAt?: number } = {}): Buffer {
  const bodyAt = opts.bodyAt ?? DISC;
  const first = opts.first ?? 0;
  const capacity = opts.capacity ?? lines.length + first;
  const buf = Buffer.alloc(bodyAt + STORE_HEADER + capacity * LINE_LEN);
  const body = buf.subarray(bodyAt);
  body[0] = 3;
  body.writeUInt32LE(lines.length, 4);
  (opts.account ?? PublicKey.default).toBuffer().copy(body, 8);
  body.writeUInt32LE(opts.roomReserved ?? 0, 88);
  body.writeUInt32LE(first, 92);
  lines.forEach((l, i) => {
    const at = STORE_HEADER + (first + i) * LINE_LEN;
    body[at] = l.side ?? 0;
    body[at + 1] = l.cls ?? 3;
    body[at + 2] = l.tranche ?? 0;
    body.writeBigInt64LE(l.dueAt ?? 0n, at + 3);
    (l.source ?? PublicKey.default).toBuffer().copy(body, at + 11);
    body.writeBigUInt64LE(l.amount ?? 0n, at + 43);
  });
  return buf;
}

export const potBytes = (lines: Partial<StoreLine>[], opts: Parameters<typeof storeBytes>[1] = {}) => storeBytes(lines, { ...opts, bodyAt: POT_AT });

/** A Ticket account head (tests): see programs/tesoro_core/src/pots.rs. */
export function ticketBytes(h: { kind?: number; state?: number; account: PublicKey; game?: PublicKey; payer?: PublicKey; nonce?: bigint; target?: bigint; expiresAt?: number; spillRoom?: number }, lines: Partial<StoreLine>[] = []): Buffer {
  const buf = potBytes(lines, { capacity: Math.max(lines.length, 1) });
  const head = buf.subarray(DISC, DISC + 160);
  head[0] = 1;
  head[2] = h.kind ?? 0;
  head[3] = h.state ?? 0;
  h.account.toBuffer().copy(head, 8);
  (h.game ?? PublicKey.default).toBuffer().copy(head, 40);
  (h.payer ?? PublicKey.default).toBuffer().copy(head, 72);
  head.writeBigUInt64LE(h.nonce ?? 0n, 104);
  head.writeBigUInt64LE(h.target ?? 0n, 112);
  head.writeBigInt64LE(BigInt(h.expiresAt ?? 0), 120);
  head.writeUInt32LE(h.spillRoom ?? 0, 132);
  return buf;
}

// ---- Decoded accounts from the IDL (tests) ------------------------------------------------------------------------

import anchor from "@coral-xyz/anchor";

const BIG = new Set(["u64", "i64", "u128", "i128", "u256", "i256"]);

/** A zero value for any IDL type: numbers 0 (BN for 64 bits and more), keys default, vec empty, option none, enum its first variant. */
export function zeroOf(idl: any, ty: any): any {
  if (typeof ty === "string") {
    if (ty === "bool") return false;
    if (ty === "pubkey") return PublicKey.default;
    if (ty === "string") return "";
    if (BIG.has(ty)) return new anchor.BN(0);
    return 0;
  }
  if ("array" in ty) return Array.from({ length: ty.array[1] }, () => zeroOf(idl, ty.array[0]));
  if ("vec" in ty) return [];
  if ("option" in ty) return null;
  if ("defined" in ty) {
    const def = idl.types.find((t: any) => t.name === ty.defined.name);
    if (!def) throw new Error(`zeroOf: no type ${ty.defined.name}`);
    if (def.type.kind === "enum") {
      const v = def.type.variants[0];
      const key = v.name[0].toLowerCase() + v.name.slice(1);
      if (!v.fields) return { [key]: {} };
      if (typeof v.fields[0] === "object" && "name" in v.fields[0]) return { [key]: Object.fromEntries(v.fields.map((f: any) => [f.name, zeroOf(idl, f.type)])) };
      return { [key]: v.fields.map((f: any) => zeroOf(idl, f)) };
    }
    return Object.fromEntries(def.type.fields.map((f: any) => [f.name, zeroOf(idl, f.type)]));
  }
  throw new Error(`zeroOf: ${JSON.stringify(ty)}`);
}

const isPlain = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof PublicKey) && !(v instanceof anchor.BN) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array);
const merge = (base: any, over: any): any => {
  if (!isPlain(over) || !isPlain(base)) return over;
  // an enum variant other than the zero value replaces it
  if (Object.keys(over).length && !Object.keys(over).some((k) => k in base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
};

/** Account bytes of `name` (an IDL account, camelCase field names as the client decodes them) with `over` merged into an all-zero value. */
export async function accountBytes(core: anchor.Program<any>, name: string, over: Record<string, any> = {}): Promise<Buffer> {
  const idl = core.idl as any;
  const key = name[0].toLowerCase() + name.slice(1);
  const value = merge(zeroOf(idl, { defined: { name: key } }), over);
  return await core.coder.accounts.encode(key, value);
}

/** A Source book account (tests): classes 0.. with the given closed-segment counts (4 + extensions). */
export function bookBytes(cks: number[]): Buffer {
  const classes = cks.length;
  const buf = Buffer.alloc(8 + 40 + 3 * 144 + 82 + classes * 128);
  buf[8 + 40 + 3 * 144 + 81] = classes - 4;
  cks.forEach((ck, c) => buf.writeUInt32LE(ck, 8 + 40 + 3 * 144 + 82 + c * 128 + 120));
  return buf;
}

/** The IDL name of the instruction `ix` calls (tests). */
export function ixNameOf(core: anchor.Program<any>, ix: { data: Buffer | Uint8Array }): string {
  const d = Buffer.from(ix.data).subarray(0, 8);
  const hit = (core.idl as any).instructions.find((i: any) => Buffer.from(i.discriminator).equals(d));
  return hit ? hit.name : "?";
}

// ---- Core events in transactions (tests) --------------------------------------------------------------------------

import { eventAuthority } from "./kit.ts";
import { loadIdl } from "./runtime.ts";

const coreRaw = loadIdl("tesoro_core");
const rawCoder = new anchor.BorshCoder(coreRaw);
const EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
export const CORE_PROGRAM = new PublicKey(coreRaw.address);

/** The data of one event-CPI exactly as core emits it: tag, event discriminator, Borsh body (snake_case fields). */
export function eventData(name: string, body: Record<string, unknown>): Buffer {
  const wire = (v: unknown): unknown => (typeof v === "bigint" ? new anchor.BN(v.toString()) : Array.isArray(v) ? v.map(wire) : v);
  const bytes = rawCoder.types.encode(name, Object.fromEntries(Object.entries(body).map(([k, v]) => [k, wire(v)])));
  const disc = Buffer.from(coreRaw.events.find((e: any) => e.name === name).discriminator);
  return Buffer.concat([EVENT_TAG, disc, bytes]);
}

/** A `getTransaction` answer whose inner instructions are core's event-CPIs (or any other program's, with `programId`). */
export function eventTx(o: { slot?: number; blockTime?: number; events: { name: string; body: Record<string, unknown>; programId?: PublicKey }[]; failed?: boolean }) {
  const keys = [Keypair.generate().publicKey, eventAuthority, CORE_PROGRAM];
  const extra: PublicKey[] = [];
  const instructions = o.events.map((e) => {
    let pi = 2;
    if (e.programId) {
      extra.push(e.programId);
      pi = keys.length + extra.length - 1;
    }
    return { programIdIndex: pi, accounts: [1], data: anchor.utils.bytes.bs58.encode(eventData(e.name, e.body)) };
  });
  return {
    slot: o.slot ?? 1,
    blockTime: o.blockTime ?? 1_800_000_000,
    meta: { err: o.failed ? { InstructionError: [0, "Custom"] } : null, innerInstructions: [{ index: 0, instructions }] },
    transaction: { message: { staticAccountKeys: [...keys, ...extra] } },
  };
}

/** A scripted connection for the event scan: `txs` is newest first, as the RPC lists them. */
export function scriptedConn(txs: { signature: string; tx: ReturnType<typeof eventTx> | null }[]) {
  const calls = { list: 0, get: [] as string[] };
  return {
    calls,
    async getSignaturesForAddress(_addr: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) {
      calls.list++;
      let list = txs;
      if (opts.before) list = list.slice(list.findIndex((t) => t.signature === opts.before) + 1);
      if (opts.until) {
        const at = list.findIndex((t) => t.signature === opts.until);
        if (at >= 0) list = list.slice(0, at);
      }
      return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature, slot: t.tx?.slot ?? 0, blockTime: t.tx?.blockTime ?? null, err: t.tx?.meta.err ?? null, memo: null, confirmationStatus: "confirmed" as const }));
    },
    async getTransaction(signature: string) {
      calls.get.push(signature);
      return txs.find((t) => t.signature === signature)?.tx ?? null;
    },
  };
}

/** A stand-in for `ctx.core` whose `account.<name>.fetch / fetchNullable` read from `accounts` (tests); `methods` and `coder` are real. */
export function chainOf(core: anchor.Program<any>, accounts: Map<string, Buffer>) {
  const account = new Proxy(
    {},
    {
      get: (_t, name: string) => ({
        fetchNullable: async (addr: PublicKey) => (accounts.has(addr.toBase58()) ? core.coder.accounts.decode(name, accounts.get(addr.toBase58())!) : null),
        fetch: async (addr: PublicKey) => {
          const data = accounts.get(addr.toBase58());
          if (!data) throw new Error(`Account does not exist ${addr.toBase58()}`);
          return core.coder.accounts.decode(name, data);
        },
      }),
    },
  );
  return { methods: core.methods, coder: core.coder, programId: core.programId, account } as any;
}
