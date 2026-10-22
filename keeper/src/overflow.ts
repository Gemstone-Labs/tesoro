import { PublicKey } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { claimOverflowIx, growStoreIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { basketOf, decodeStore, keyOf, slack, spillOf, type StoreLine } from "./kit.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { connReader, supplySources, type Reader } from "./supply.ts";

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
  lines: StoreLine[];
}

/** A decoded overflow record (storage.rs `OverflowHead` + a line store). */
export function overflowRowOf(address: PublicKey, data: Uint8Array): OverflowRow {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const store = decodeStore(data, OVERFLOW_STORE_AT);
  return { address, payer: new PublicKey(buf.subarray(8, 40)), kind: buf[40], owner: store.account, lines: store.lines() };
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
    const [b, s] = await d.read.many([basketOf(row.owner), spillOf(row.owner)]);
    if (!b || !s) {
      log("overflow", subject, "WARN the owner's stores are missing");
      continue;
    }
    const room = slack(decodeStore(b.data), decodeStore(s.data));
    const step = claimStep(row, room, ctx.payer.publicKey);
    if (step.kind === "wait") continue;
    if (step.kind === "grow") {
      const g = await act(ctx, "overflow", subject, "grow_store spill by 1 (a prize waits for room)", async () =>
        d.send([await growStoreIx(ctx.core, { payer: ctx.payer.publicKey, account: row.owner, which: "spill", extra: 1 })], {}),
      );
      actions += +g.ok;
      if (!g.ok) continue;
    }
    const lines = row.lines.slice(0, CLAIM_LINES);
    const supply = await supplySources(ctx.core, d.read, lines.map((l) => ({ source: keyOf(l.source), cut: false })));
    const r = await act(ctx, "overflow", subject, `claim_overflow (${row.lines.length} line(s), rent to ${shortKey(row.payer)})`, async () =>
      d.send([await claimOverflowIx(ctx.core, { account: row.owner, record: row.address, payer: row.payer, max: CLAIM_LINES, remaining: supply.metas })], { units: 400_000 }),
    );
    actions += +r.ok;
  }
  return actions;
}
