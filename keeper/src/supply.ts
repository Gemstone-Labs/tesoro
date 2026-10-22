import { PublicKey, type AccountInfo, type AccountMeta, type Connection } from "@solana/web3.js";
import type { Ahead } from "./chunks.ts";
import type { Core } from "./core-ix.ts";
import { meta } from "./core-ix.ts";
import { bookOf, ckptOf, keyOf, pda } from "./kit.ts";

export type Info = AccountInfo<Buffer> | null;

/** Reads accounts in order; `null` for one that does not exist. */
export interface Reader {
  many(keys: PublicKey[]): Promise<Info[]>;
}

/** A Reader over a connection, in batches of 100 (the RPC limit). */
export function connReader(conn: Pick<Connection, "getMultipleAccountsInfo">): Reader {
  return {
    async many(keys) {
      const out: Info[] = [];
      for (let i = 0; i < keys.length; i += 100) out.push(...((await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")) as Info[]));
      return out;
    },
  };
}

/** The wrapped SOL-like mint of the test staking token: a Solana Position of this asset is a native one. */
export const SIM_SOL_MINT = new PublicKey("3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ");

// ---- Source books -------------------------------------------------------------------------------------------------

const COUNTERS_AT = 8 + 40;
const BOOK_AT = COUNTERS_AT + 3 * 144;
const BOOK_FIXED_LEN = 82;
const CLASS_LEN = 128;
const CKPT_PER_PAGE = 32;

/** The closed-segment counts (`ck`) of a book's classes, index = class. */
export function bookCheckpointCounts(data: Uint8Array): number[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const nExt = buf[BOOK_AT + 81];
  const classes = 4 + nExt;
  const out: number[] = [];
  for (let c = 0; c < classes; c++) {
    const at = BOOK_AT + BOOK_FIXED_LEN + c * CLASS_LEN;
    out.push(at + 124 <= buf.length ? buf.readUInt32LE(at + 120) : 0);
  }
  return out;
}

/** The checkpoint pages a chunk may need of a Source: for every class that writes records (not Platform, not Leaderboard), the page being filled and its neighbours. */
export function pageCandidates(counts: number[]): { cls: number; page: number }[] {
  const out: { cls: number; page: number }[] = [];
  counts.forEach((ck, cls) => {
    if (cls === 0 || cls === 2) return;
    const cur = Math.floor(ck / CKPT_PER_PAGE);
    for (const page of [cur - 1, cur, cur + 1]) if (page >= 0) out.push({ cls, page });
  });
  return out;
}

export interface SourceSupply {
  /** book + existing checkpoint pages (+ the Source, its Position, the custody and its rate account when a fee is cut). */
  metas: AccountMeta[];
  /** Sources whose book does not exist (the chunk will refuse them). */
  missing: PublicKey[];
}

const dedupe = (metas: AccountMeta[]): AccountMeta[] => {
  const seen = new Map<string, AccountMeta>();
  for (const m of metas) {
    const k = m.pubkey.toBase58();
    const prev = seen.get(k);
    if (!prev) seen.set(k, { ...m });
    else prev.isWritable ||= m.isWritable;
  }
  return [...seen.values()];
};
export { dedupe };

/** What kind of Position a Source belongs to, and where its custody and rate account are. */
export function kindAccounts(core: Core, position: any, readInfo: (key: PublicKey) => Info): AccountMeta[] {
  const chain = Object.keys(position.inner.sourceChain)[0];
  if (chain !== "solana") return [];
  const asset = keyOf(position.inner.sourceAsset);
  if (asset.equals(SIM_SOL_MINT)) {
    const custody = pda("native");
    const info = readInfo(custody);
    if (!info) return [meta(custody, false)];
    const c: any = core.coder.accounts.decode("nativeCustody", info.data);
    return [meta(custody, false), meta(c.pool, false)];
  }
  if (Number(position.inner.stakeRateOpen?.toString() ?? 0) === 0) return [];
  const custody = pda("stake_custody", asset.toBuffer());
  const info = readInfo(custody);
  if (!info) return [meta(custody, false)];
  const c: any = core.coder.accounts.decode("stakeCustody", info.data);
  return [meta(custody, false), meta(c.pool, false)];
}

/**
 * The accounts the Sources of the next steps need (programs/tesoro_core/src/instructions/settlement.rs): each Source's
 * book and checkpoint pages, and for a fee cut the SourceState, its Position and, for the Position's open Advance, the
 * kind's custody and rate account. Order does not matter to the program.
 */
export async function supplySources(core: Core, read: Reader, ahead: Ahead[]): Promise<SourceSupply> {
  const metas: AccountMeta[] = [];
  const missing: PublicKey[] = [];
  if (!ahead.length) return { metas, missing };
  const books = await read.many(ahead.map((a) => bookOf(a.source)));
  const candidates: { key: PublicKey }[] = [];
  ahead.forEach((a, i) => {
    const book = books[i];
    if (!book) {
      missing.push(a.source);
      return;
    }
    metas.push(meta(bookOf(a.source)));
    for (const { cls, page } of pageCandidates(bookCheckpointCounts(book.data))) candidates.push({ key: ckptOf(a.source, cls, page) });
  });
  const pages = await read.many(candidates.map((c) => c.key));
  candidates.forEach((c, i) => {
    if (pages[i]) metas.push(meta(c.key));
  });

  const cuts = ahead.filter((a) => a.cut && !missing.some((m) => m.equals(a.source)));
  if (cuts.length) {
    const states = await read.many(cuts.map((a) => a.source));
    const positions: PublicKey[] = [];
    states.forEach((s, i) => {
      if (!s) return;
      metas.push(meta(cuts[i].source));
      const state: any = core.coder.accounts.decode("sourceState", s.data);
      positions.push(keyOf(state.inner.position));
    });
    const posInfos = await read.many(positions);
    const infoOf = new Map<string, Info>();
    const decoded: any[] = [];
    positions.forEach((p, i) => {
      if (!posInfos[i]) return;
      metas.push(meta(p));
      decoded.push(core.coder.accounts.decode("positionState", posInfos[i]!.data));
    });
    // The custody (and then its rate account) of every kind that appears, read once each.
    const custodyKeys = new Set<string>();
    for (const p of decoded) {
      const chain = Object.keys(p.inner.sourceChain)[0];
      if (chain !== "solana") continue;
      const asset = keyOf(p.inner.sourceAsset);
      if (asset.equals(SIM_SOL_MINT)) custodyKeys.add(pda("native").toBase58());
      else if (Number(p.inner.stakeRateOpen?.toString() ?? 0) !== 0) custodyKeys.add(pda("stake_custody", asset.toBuffer()).toBase58());
    }
    const keys = [...custodyKeys].map((k) => new PublicKey(k));
    const infos = await read.many(keys);
    keys.forEach((k, i) => infoOf.set(k.toBase58(), infos[i]));
    for (const p of decoded) metas.push(...kindAccounts(core, p, (k) => infoOf.get(k.toBase58()) ?? null));
  }
  return { metas: dedupe(metas), missing };
}
