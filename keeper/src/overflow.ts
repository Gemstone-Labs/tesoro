import { PublicKey } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { claimOverflowIx, growStoreIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { OVERFLOW_MATCH, basketOf, bookOf, ckptOf, decodeStore, keyOf, matchAddress, slack, spillOf, type StoreLine } from "./kit.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { bookCheckpointCounts, connReader, supplySources, type Reader } from "./supply.ts";

/** Where an overflow record's line store starts: 8 B discriminator, a 73 B head (payer 32, kind 1, id 40). */
export const OVERFLOW_STORE_AT = 8 + 32 + 1 + 40;
/** Lines one claim moves, so its books and pages fit one transaction. */
const CLAIM_LINES = 4;
const PER_PASS = 40;

export interface OverflowRow {
  address: PublicKey;
  /** Who paid the rent; it goes back there when the record is empty. */
  payer: PublicKey;
  kind: number;
  /** The Account the lines belong to. */
  owner: PublicKey;
  /** The Match account of a Match record: naming it lets the claim close the record once the Match is gone. */
  match: PublicKey | null;
  lines: StoreLine[];
}

/** A decoded overflow record (storage.rs `OverflowHead` + a line store). */
export function overflowRowOf(address: PublicKey, data: Uint8Array): OverflowRow {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const store = decodeStore(data, OVERFLOW_STORE_AT);
  const kind = buf[40];
  const match = kind === OVERFLOW_MATCH ? matchAddress({ opener: new PublicKey(buf.subarray(41, 73)), n: buf.readBigUInt64LE(73) }) : null;
  return { address, payer: new PublicKey(buf.subarray(8, 40)), kind, owner: store.account, match, lines: store.lines() };
}

export type ClaimStep = { kind: "claim" } | { kind: "grow" } | { kind: "wait" };

/**
 * What to do with a record. An empty one is claimed (that closes it and returns the rent). Lines are claimed once the owner's
 * stores have a free slot beyond the held ones. With no room, the keeper makes one only for a record it paid for itself (a Season
 * prize); the lines of a Match belong to its Players, who grow a store or spend, and the record waits.
 */
export function claimStep(row: OverflowRow, slackOf: number, keeper: PublicKey): ClaimStep {
  if (!row.lines.length || slackOf > 0) return { kind: "claim" };
  return row.payer.equals(keeper) ? { kind: "grow" } : { kind: "wait" };
}

export interface OverflowDeps {
  list: Lister;
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
}

export const realOverflowDeps = (ctx: Ctx): OverflowDeps => ({
  list: connLister(ctx.conn),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
});

/** Checkpoint records one catch-up reads (`MAX_CATCHUP_SCALE_STEPS + 1`), as in the app's `ckptPagesFor`. */
const CATCHUP_RECORDS = 11;
const RECORDS_PER_PAGE = 32;

/**
 * The checkpoint pages the lines a claim touches read when a claimed line merges into an older one (`MissingCheckpoint`
 * without them): for each Source, the records from the line's checkpoint up to the class's, those that exist. Pages already
 * supplied are left out.
 */
export async function stalePages(read: Pick<Reader, "many">, lines: StoreLine[], supplied: PublicKey[]): Promise<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]> {
  const sources = [...new Map(lines.map((l) => [l.source.toBase58(), l.source])).values()];
  const books = await read.many(sources.map(bookOf));
  const wanted = new Map<string, PublicKey>();
  sources.forEach((source, i) => {
    const book = books[i];
    if (!book) return;
    const counts = bookCheckpointCounts(book.data);
    for (const l of lines) {
      if (!l.source.equals(source) || l.cls === 0 || l.cls === 2) continue; // pooled classes write no records
      for (let at = l.ck; at < Math.min(counts[l.cls] ?? 0, l.ck + CATCHUP_RECORDS); at++) {
        const key = ckptOf(source, l.cls, Math.floor(at / RECORDS_PER_PAGE));
        wanted.set(key.toBase58(), key);
      }
    }
  });
  const missing = [...wanted.values()].filter((k) => !supplied.some((x) => x.equals(k)));
  const infos = await read.many(missing);
  return missing.flatMap((k, i) => (infos[i] ? [{ pubkey: k, isSigner: false, isWritable: true }] : []));
}

/** One claim step on a record (grow the spill first when the keeper paid for the record and there is no room). Returns the actions sent. */
export async function claimRecord(ctx: Ctx, d: Pick<OverflowDeps, "read" | "send">, row: OverflowRow, subject = `record=${shortKey(row.address)} owner=${shortKey(row.owner)}`): Promise<number> {
  let actions = 0;
  const [b, s] = await d.read.many([basketOf(row.owner), spillOf(row.owner)]);
  if (!b || !s) {
    log("overflow", subject, "WARN the owner's stores are missing");
    return 0;
  }
  const room = slack(decodeStore(b.data), decodeStore(s.data));
  const step = claimStep(row, room, ctx.payer.publicKey);
  if (step.kind === "wait") return 0;
  if (step.kind === "grow") {
    const g = await act(ctx, "overflow", subject, "grow_store spill by 1 (a prize waits for room)", async () =>
      d.send([await growStoreIx(ctx.core, { payer: ctx.payer.publicKey, account: row.owner, which: "spill", extra: 1 })], {}),
    );
    actions += +g.ok;
    if (!g.ok) return actions;
  }
  const lines = row.lines.slice(0, CLAIM_LINES);
  const supply = await supplySources(ctx.core, d.read, lines.map((l) => ({ source: keyOf(l.source), cut: false })));
  const held = [...decodeStore(b.data).lines(), ...decodeStore(s.data).lines()];
  const stale = await stalePages(d.read, [...lines, ...held], supply.metas.map((m) => m.pubkey));
  const r = await act(ctx, "overflow", subject, `claim_overflow (${row.lines.length} line(s), rent to ${shortKey(row.payer)})`, async () =>
    d.send([await claimOverflowIx(ctx.core, { account: row.owner, record: row.address, payer: row.payer, max: CLAIM_LINES, remaining: [...supply.metas, ...stale, ...(row.match ? [{ pubkey: row.match, isSigner: false, isWritable: false }] : [])] })], { units: 400_000 }),
  );
  return actions + +r.ok;
}

/**
 * Job: overflow records (ticket 09c). A credit that found no slot in an Account's stores sits in a record until room exists.
 * This job claims what can be claimed (anyone may), returning each record's rent to whoever paid it, and closes the empty
 * ones. The books of the Sources whose lines merge into a line the owner already holds travel with the claim.
 */
export async function overflowJob(ctx: Ctx, d: OverflowDeps = realOverflowDeps(ctx)): Promise<number> {
  const rows = (await d.list("OverflowHead")).map((r) => overflowRowOf(r.pubkey, r.data)).slice(0, PER_PASS);
  let actions = 0;
  for (const row of rows) {
    const subject = `record=${shortKey(row.address)} owner=${shortKey(row.owner)}`;
    actions += await claimRecord(ctx, d, row, subject);
  }
  return actions;
}
