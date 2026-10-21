import type { AccountMeta, PublicKey } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { cancelTicketIx, closeTicketIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { POT_AT, decodeStore, decodeTicketHead, keyOf, sponsorAddress, type TicketFacts } from "./kit.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { connReader, dedupe, supplySources, type Reader } from "./supply.ts";

/** Staged lines one `cancel_ticket` returns. */
const CANCEL_LINES = Number(process.env.KEEPER_TICKET_CANCEL_LINES ?? 12);
/** Calls one Ticket gets in one pass. */
const CANCELS_PER_PASS = 8;
/** Tickets handled in one pass. */
const TICKETS_PER_PASS = Number(process.env.KEEPER_TICKETS_PER_PASS ?? 20);
/** Size of a Ticket's head, with the discriminator (`dataSlice` of the list, so the lines are not downloaded). */
const HEAD_BYTES = 8 + 160;

export interface TicketRow {
  address: PublicKey;
  head: TicketFacts;
}

export type TicketAction = { kind: "cancel"; row: TicketRow; why: string } | { kind: "close"; row: TicketRow };

/**
 * What anyone may do with the Tickets on chain at `now`: cancel an Open Ticket once it expired (the owner can at any time;
 * the lines come back to their basket), go on with a cancel that is part done, and close a Cancelled one (its rent goes
 * back to whoever paid). A Ticket that became a Pot (`closed`) belongs to its Match.
 */
export function planTickets(rows: TicketRow[], now: number): TicketAction[] {
  const out: TicketAction[] = [];
  for (const row of rows) {
    const t = row.head;
    if (t.state === "open" && now >= t.expiresAt) out.push({ kind: "cancel", row, why: `expired ${now - t.expiresAt}s ago` });
    else if (t.state === "cancelling") out.push({ kind: "cancel", row, why: "cancel part done" });
    else if (t.state === "cancelled") out.push({ kind: "close", row });
  }
  return out;
}

/** The Offer a Backing Ticket belongs to: the Backer's Offer for this Game and amount with its Ticket open. */
export function offerOfBackingTicket(offers: { publicKey: PublicKey; account: any }[], t: TicketFacts): PublicKey | null {
  const hit = offers.find(({ account }) => {
    const o = account.inner;
    return !!o.ticketOpen && keyOf(o.backer).equals(t.account) && keyOf(o.game).equals(t.game) && BigInt(o.entry.toString()) === t.target;
  });
  return hit ? hit.publicKey : null;
}

export interface TicketDeps {
  list: Lister;
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  offers(): Promise<{ publicKey: PublicKey; account: any }[]>;
}

export const realTicketDeps = (ctx: Ctx): TicketDeps => ({
  list: connLister(ctx.conn),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  offers: () => ctx.core.account.offerState.all(),
});

/** Job: expire stale Entry and Backing Tickets and close the cancelled ones. All of it is permissionless. */
export async function ticketJob(ctx: Ctx, d: TicketDeps = realTicketDeps(ctx)): Promise<number> {
  const rows: TicketRow[] = [];
  for (const r of await d.list("TicketHead", { dataSlice: { offset: 0, length: HEAD_BYTES } })) {
    try {
      rows.push({ address: r.pubkey, head: decodeTicketHead(r.data) });
    } catch {
      // not a Ticket head we know: leave it
    }
  }
  const plan = planTickets(rows, ctx.now).slice(0, TICKETS_PER_PASS);
  let actions = 0;
  for (const step of plan) {
    const subject = `ticket=${shortKey(step.row.address)}`;
    try {
      actions += step.kind === "close" ? await closeOne(ctx, d, step.row, subject) : await cancelOne(ctx, d, step, subject);
    } catch (e) {
      log("tickets", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  if (rows.length) log("tickets", "-", `${rows.length} Ticket(s) on chain, ${plan.length} due, ${actions} action(s)`);
  return actions;
}

async function closeOne(ctx: Ctx, d: TicketDeps, row: TicketRow, subject: string): Promise<number> {
  const [sponsor] = await d.read.many([sponsorAddress]);
  const r = await act(ctx, "tickets", subject, "close_ticket (cancelled, rent goes back to who paid)", async () =>
    d.send([await closeTicketIx(ctx.core, { caller: ctx.payer.publicKey, ticket: row.address, payer: row.head.payer, sponsor: sponsor ? sponsorAddress : null })], {}),
  );
  return +r.ok;
}

async function cancelOne(ctx: Ctx, d: TicketDeps, step: Extract<TicketAction, { kind: "cancel" }>, subject: string): Promise<number> {
  const { row } = step;
  let actions = 0;
  let head = row.head;
  for (let i = 0; i < CANCELS_PER_PASS; i++) {
    const [full] = await d.read.many([row.address]);
    if (!full) return actions;
    head = decodeTicketHead(full.data);
    if (head.state === "cancelled") return actions + (await closeOne(ctx, d, { address: row.address, head }, subject));
    if (head.state !== "open" && head.state !== "cancelling") return actions;
    // The books of the Sources the staged lines came from: merging a returned line into a basket line needs them.
    const store = decodeStore(full.data, POT_AT);
    const sources = [...new Map(store.lines().filter((l) => l.amount > 0n).map((l) => [l.source.toBase58(), l.source])).values()];
    const supply = await supplySources(ctx.core, d.read, sources.map((source) => ({ source, cut: false })));
    const offer = head.kind === "backing" ? offerOfBackingTicket(await d.offers(), head) : null;
    if (head.kind === "backing" && !offer) log("tickets", subject, "WARN a Backing Ticket without its open Offer: the cancel cannot free the Offer");
    const remaining: AccountMeta[] = dedupe(supply.metas);
    const r = await act(ctx, "tickets", subject, `cancel_ticket (${head.kind}, ${step.why})`, async () =>
      d.send([await cancelTicketIx(ctx.core, { signer: ctx.payer.publicKey, owner: head.account, ticket: row.address, offer, maxLines: CANCEL_LINES, remaining })], { units: 400_000 }),
    );
    if (!r.ok || r.detail === "dry-run") return actions;
    actions++;
  }
  return actions;
}
