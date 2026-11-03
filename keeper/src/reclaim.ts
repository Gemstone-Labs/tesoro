import { PublicKey } from "@solana/web3.js";
import { act, type Ctx } from "./act.ts";
import { closePairIx, closeReceiptIx } from "./core-ix.ts";
import { keyOf } from "./kit.ts";
import type { Lister } from "./lists.ts";
import type { SendOpts } from "./send.ts";
import type { sendIxs } from "./send.ts";

/**
 * Rent Tesoro gets back: settlement receipts past their keeping time and pair counters whose window ended. The one place
 * that plans and sends `close_receipt` and `close_pair`; the janitor (daily) and the loop's sweep job both call it.
 */

/** A settlement receipt is kept this long (RECEIPT_KEEP_SECS of tesoro_core). */
export const RECEIPT_KEEP_SECS = 14 * 24 * 3600;
/** A pair counter's window (PAIR_WINDOW_SECS of tesoro_core). */
export const PAIR_WINDOW_SECS = 24 * 3600;
/** Accounts closed in one transaction. */
export const PER_TX = 6;
/** Bytes of a pair record that names its Players; shorter ones (pre-upgrade, devnet) are under another seed and are skipped. */
export const PAIR_RECORD_LEN = 8 + 1 + 32 + 8 + 2 + 32 + 32;
/** The head of a pair record the planner reads: discriminator, bump, payer, window start. */
export const PAIR_HEAD_BYTES = 8 + 1 + 32 + 8;

export interface ReclaimDeps {
  list: Lister;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
}

export interface ReceiptRow {
  address: PublicKey;
  payer: PublicKey;
  at: number;
}

/** A decoded `SettlementReceipt`. */
export const receiptOf = (address: PublicKey, r: any): ReceiptRow => ({ address, payer: keyOf(r.payer), at: Number(r.receipt.at.toString()) });

/** Receipts past their keeping time: closing returns the rent to whoever paid it. */
export const oldReceipts = (rows: ReceiptRow[], now: number) => rows.filter((r) => now >= r.at + RECEIPT_KEEP_SECS);

export const groupsOf = <T>(items: T[], n: number): T[][] => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, (i + 1) * n));

export interface PairRow {
  address: PublicKey;
  payer: PublicKey;
  windowStart: number;
}

/** A pair row from a record or its first PAIR_HEAD_BYTES. */
export const pairRowOf = (r: { pubkey: PublicKey; data: Buffer }): PairRow => ({
  address: r.pubkey,
  payer: new PublicKey(r.data.subarray(9, 41)),
  windowStart: Number(r.data.readBigInt64LE(41)),
});

export const pairsToClose = (rows: PairRow[], now: number) => rows.filter((p) => now >= p.windowStart + PAIR_WINDOW_SECS);

/** Closes up to `limit` old receipts; returns the sends that went out and how many were due. */
export async function closeOldReceipts(ctx: Ctx, d: ReclaimDeps, who: string, limit: number): Promise<{ actions: number; due: number }> {
  const rows = (await d.list("SettlementReceipt")).map((r) => receiptOf(r.pubkey, ctx.core.coder.accounts.decode("settlementReceipt", r.data)));
  const due = oldReceipts(rows, ctx.now).slice(0, limit);
  let actions = 0;
  for (const group of groupsOf(due, PER_TX)) {
    const r = await act(ctx, who, `receipts=${group.length}`, `close_receipt x${group.length} (14 days old)`, async () =>
      d.send(await Promise.all(group.map((g) => closeReceiptIx(ctx.core, { caller: ctx.payer.publicKey, receipt: g.address, payer: g.payer }))), {}),
    );
    actions += +r.ok;
  }
  return { actions, due: due.length };
}

/** Closes up to `limit` pair counters whose 24 h window is over; the scan reads only their head. */
export async function closeOldPairs(ctx: Ctx, d: ReclaimDeps, who: string, limit: number): Promise<{ actions: number; due: number }> {
  const rows = (await d.list("PairState", { dataSize: PAIR_RECORD_LEN, dataSlice: { offset: 0, length: PAIR_HEAD_BYTES } })).map(pairRowOf);
  const due = pairsToClose(rows, ctx.now).slice(0, limit);
  let actions = 0;
  for (const group of groupsOf(due, PER_TX)) {
    const r = await act(ctx, who, `pairs=${group.length}`, `close_pair x${group.length} (24 h window over)`, async () =>
      d.send(await Promise.all(group.map((g) => closePairIx(ctx.core, { caller: ctx.payer.publicKey, pair: g.address, payer: g.payer }))), {}),
    );
    actions += +r.ok;
  }
  return { actions, due: due.length };
}
