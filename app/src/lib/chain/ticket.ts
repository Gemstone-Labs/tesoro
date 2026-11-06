/**
 * Entry Tickets and Backing Tickets on the client (tesoro_core `open_ticket`, `grow_ticket`, `stage_entry`,
 * `cancel_ticket`, `close_ticket`; programs/tesoro_core/src/{pots,instructions/ticket}.rs).
 *
 * An entry of more than 16 lines is prepared in steps: open a Ticket with room for the lines, stage the draw in
 * transactions of up to 32 lines, then `open_match` / `join_match` takes the complete Ticket as the Pot. The Ticket
 * can be cancelled at any time (the lines go back), and a staged Ticket survives a reload: `findOpenTickets` finds it.
 *
 * Backing Tickets are single-signer (ticket 18b): the Requester opens it and stages the Backer's lines in the same
 * transaction; the accepted Offer is the Backer's consent.
 */
import { PublicKey, SystemProgram, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { accountOfSigner, BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { cosigned, ticketSteps } from "@/lib/seat/cosigned";
import type { SeatKey } from "@/lib/seat/seat-key";
import type { GameId } from "@/lib/mock/types";
import { FLAG_BACKING_OPEN, FLAG_TICKET_OPEN, MAX_GROW_LINES, basketPda, countersPda, decodeStore, playableTotal, sponsorPda, spillPda, ticketPda, type Line, type Store } from "./basket";
import { coreIx as rawCoreIx, metaOf, type AccountsByName } from "./core-ix";
import type { GetToken } from "./demo-client";
import { DISC, POT_AT, TICKET_HEAD, TICKET_VERSION, decodeTicketHead } from "./pot-store";
import { booksFor, drawRemaining, MAX_INITIAL_TICKET_LINES, readEntryStores, readNextTicket, relayerKey, sendEntryTx, STAGE_OPS, type EntryStores } from "./entry";
import { getChain } from "./client";
import { planDraw } from "./draw";
import { GAME_IDS } from "./games";
import { sponsoredSend } from "./sponsor-client";

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const coreIx = (name: string, accounts: AccountsByName, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []) =>
  rawCoreIx(name, Object.fromEntries(Object.entries(accounts).map(([k, v]) => [snake(k), v])), Object.fromEntries(Object.entries(args).map(([k, v]) => [snake(k), v])), remaining);

export type TicketKind = "entry" | "backing";
export type TicketState = "open" | "cancelling" | "closed" | "cancelled";

/** `TICKET_WINDOW_SECS`: an unconsumed Ticket can be cancelled by anyone after this long. */
export const TICKET_WINDOW_SECS = 60 * 60;

const HEAD_AT = 8;

export interface TicketView {
  address: PublicKey;
  kind: TicketKind;
  state: TicketState;
  /** The Account whose basket the lines come from and go back to. */
  account: PublicKey;
  game: PublicKey;
  /** Who paid the rent (the relayer when sponsored). */
  payer: PublicKey;
  nonce: bigint;
  /** The entry size (or the Backing's amount). */
  target: bigint;
  expiresAt: number;
  /** Lines the storage holds. */
  lineCap: number;
  /** Gemas staged so far (the Ticket's lines). */
  staged: bigint;
  /** Lines staged so far. */
  lines: number;
  /** Backing: reservation not staged yet. */
  reservedLeft: bigint;
  /** The staged lines, in key order. */
  stagedLines: Line[];
  /** A Backing Ticket: the nonce of the Offer that opened it. */
  offerNonce: bigint;
}

/** Decodes a Ticket / Pot account's data: its head (`decodeTicketHead`, layout in pots.rs) and its line store. */
export function decodeTicket(address: PublicKey, data: Uint8Array): TicketView {
  if (data.length < POT_AT + 128) throw new Error("ticket account too short");
  if (data[DISC] !== TICKET_VERSION) throw new Error(`unknown ticket version ${data[DISC]}`);
  const f = decodeTicketHead(data);
  const dv = new DataView(data.buffer, data.byteOffset + DISC, TICKET_HEAD);
  // the line store sits after the head (`decodeStore` skips its own 8-byte discriminator slot)
  const store: Store = decodeStore(data.subarray(TICKET_HEAD));
  return {
    address,
    kind: f.kind,
    state: f.state,
    account: f.account,
    game: f.game,
    payer: f.payer,
    nonce: f.nonce,
    target: f.target,
    expiresAt: f.expiresAt,
    lineCap: dv.getUint32(128, true),
    staged: store.header.ownTotal + store.header.wonTotal,
    lines: store.header.len,
    reservedLeft: dv.getBigUint64(136, true),
    stagedLines: store.lines,
    offerNonce: f.offerNonce,
  };
}

export async function readTicket(address: PublicKey, conn: Pick<Connection, "getAccountInfo"> = getChain().base): Promise<TicketView | null> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) return null;
  try {
    return decodeTicket(address, info.data);
  } catch {
    return null;
  }
}

/** The Tickets of one Account that are not closed, newest first (for resuming after a reload). */
export async function findOpenTickets(account: PublicKey): Promise<TicketView[]> {
  const chain = getChain();
  const rows = await chain.base.getProgramAccounts(chain.core.programId, {
    filters: [{ memcmp: chain.core.coder.accounts.memcmp("ticketHead") }, { memcmp: { offset: HEAD_AT + 8, bytes: account.toBase58() } }],
  });
  const out: TicketView[] = [];
  for (const r of rows) {
    try {
      const t = decodeTicket(r.pubkey, r.account.data);
      if (t.state === "open" || t.state === "cancelling") out.push(t);
    } catch {
      // not a Ticket of this layout
    }
  }
  return out.sort((a, b) => (a.nonce < b.nonce ? 1 : -1));
}

// ---- pure state for the screens ----------------------------------------------------------

export interface StagedEntry {
  staged: bigint;
  target: bigint;
  /** 0..1 */
  progress: number;
  complete: boolean;
  /** Being cancelled, or already cancelled: nothing more to stage. */
  cancelling: boolean;
  expired: boolean;
  /** Stage transactions still needed at 32 lines each (an estimate from the lines left). */
  stepsLeft: number;
  /** Seconds until anyone may cancel it (0 once expired). */
  expiresIn: number;
}

export function stagedEntryState(t: TicketView, nowSec = Math.floor(Date.now() / 1000)): StagedEntry {
  const progress = t.target === 0n ? 0 : Number((t.staged * 1000n) / t.target) / 1000;
  const complete = t.state === "open" && t.staged >= t.target;
  return {
    staged: t.staged,
    target: t.target,
    progress: Math.min(1, progress),
    complete,
    cancelling: t.state === "cancelling" || t.state === "cancelled",
    expired: nowSec >= t.expiresAt,
    stepsLeft: complete ? 0 : Math.max(1, Math.ceil(Math.max(1, t.lineCap - t.lines) / STAGE_OPS)),
    expiresIn: Math.max(0, t.expiresAt - nowSec),
  };
}

/** Is a Ticket open on this basket (header flags)? Entry and Backing Tickets have their own bit. */
export const hasOpenTicket = (basket: Store) => (basket.header.flags & (FLAG_TICKET_OPEN | FLAG_BACKING_OPEN)) !== 0;

// ---- builders ------------------------------------------------------------------------------

export interface OpenTicketArgs {
  payer: PublicKey;
  /** The wallet that signs: the owner for an Entry Ticket, the Requester for a Backing Ticket. */
  authority: PublicKey;
  /** The seat key that co-signs and may stage and cancel an Entry Ticket; the wallet names itself when absent. */
  seatSigner?: PublicKey;
  /** The Account whose lines are staged: the Player's own, or the Backer's. */
  owner: PublicKey;
  nonce: bigint;
  kind: TicketKind;
  game: GameId;
  /** The entry size. */
  target: bigint;
  /** Storage lines to open with (at most `MAX_INITIAL_TICKET_LINES`; `growTicketIxs` adds the rest). */
  lines: number;
  /** Backing: the accepted Offer. */
  offer?: PublicKey;
  sponsored: boolean;
}

const requesterOf = (authority: PublicKey) => BlockPuzzleChain.coreAccount(authority);

export function openTicketIx(a: OpenTicketArgs): TransactionInstruction {
  return coreIx(
    "open_ticket",
    {
      payer: a.payer,
      authority: a.authority,
      seatSigner: a.seatSigner ?? a.authority,
      requester: requesterOf(a.authority),
      owner: a.owner,
      basket: basketPda(a.owner),
      spill: spillPda(a.owner),
      ticket: ticketPda(a.owner, a.nonce),
      offer: a.offer,
      sponsor: a.sponsored ? sponsorPda() : undefined,
      counters: countersPda(a.owner),
      systemProgram: SystemProgram.programId,
    },
    { nonce: new BN(a.nonce.toString()), kind: a.kind === "backing" ? { Backing: {} } : { Entry: {} }, game: GAME_IDS[a.game], target: new BN(a.target.toString()), lines: Math.min(a.lines, MAX_INITIAL_TICKET_LINES) },
  );
}

/** `grow_ticket` instructions that add `extra` lines of storage, at most `MAX_GROW_LINES` each. Not sponsored: the Player pays the (refundable) rent. */
export function growTicketIxs(payer: PublicKey, owner: PublicKey, ticket: PublicKey, extra: number): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  for (let left = extra; left > 0; left -= MAX_GROW_LINES) {
    const accounts: AccountsByName = { payer, owner, ticket, sponsor: undefined, systemProgram: SystemProgram.programId };
    out.push(coreIx("grow_ticket", accounts, { extraLines: Math.min(left, MAX_GROW_LINES) }));
  }
  return out;
}

export function stageEntryIx(signer: PublicKey, owner: PublicKey, ticket: PublicKey, maxOps: number, remaining: AccountMeta[]): TransactionInstruction {
  return coreIx("stage_entry", { signer, owner, basket: basketPda(owner), spill: spillPda(owner), ticket }, { maxOps: Math.min(Math.max(maxOps, 1), STAGE_OPS) }, remaining);
}

export function cancelTicketIx(signer: PublicKey, owner: PublicKey, ticket: PublicKey, maxLines: number, offer: PublicKey | undefined, remaining: AccountMeta[]): TransactionInstruction {
  return coreIx("cancel_ticket", { signer, owner, basket: basketPda(owner), spill: spillPda(owner), ticket, offer }, { maxLines: Math.min(Math.max(maxLines, 1), 255) }, remaining);
}

export function closeTicketIx(caller: PublicKey, ticket: PublicKey, payer: PublicKey, sponsored: boolean): TransactionInstruction {
  return coreIx("close_ticket", { caller, ticket, payer, sponsor: sponsored ? sponsorPda() : undefined });
}

// ---- flows ---------------------------------------------------------------------------------

/** Pool Gemas a stage may still draw: the whole playable total (the open Ticket's own need is not a reservation against itself). */
const stageLimit = (s: Pick<EntryStores, "basket" | "spill">) => playableTotal(s.basket, s.spill);

/** The stage instruction for the lines still missing from `t`, with the Source books it needs. Null when nothing is left to stage. */
export async function nextStageIx(signer: PublicKey, t: TicketView, stores: Pick<EntryStores, "basket" | "spill">): Promise<TransactionInstruction | null> {
  const left = t.target - t.staged;
  if (left <= 0n) return null;
  const plan = planDraw(stores.basket, stores.spill, left, stageLimit(stores));
  const slice = { steps: plan.steps.slice(0, STAGE_OPS) };
  return stageEntryIx(signer, t.account, t.address, STAGE_OPS, await drawRemaining(slice));
}

export interface PrepareArgs {
  /** The wallet (never a seat key). */
  signer: ChainSigner;
  /** The seat key named in the entry: it co-signs the Ticket's opening and stages the rest, so the wallet signs once. */
  seat?: SeatKey;
  getToken: GetToken;
  game: GameId;
  entry: bigint;
  /** Lines the draw needs (`previewEntry(...).ticketLines`). */
  lines: number;
  onProgress?: (s: StagedEntry) => void;
}

async function restage(signer: ChainSigner, getToken: GetToken, t: TicketView, onProgress?: (s: StagedEntry) => void, seat?: SeatKey): Promise<TicketView> {
  let view = t;
  // an Entry Ticket is staged by the seat key it names (no wallet signature); the wallet pays when the relayer cannot
  const stager = seat ? ticketSteps(signer, seat) : signer;
  const selfPay = seat ? cosigned(signer, seat) : undefined;
  const maxTx = Math.ceil(view.lineCap / STAGE_OPS) + 8;
  for (let i = 0; i < maxTx; i++) {
    onProgress?.(stagedEntryState(view));
    if (view.staged >= view.target) return view;
    const stores = await readEntryStores(view.account);
    const ix = await nextStageIx(stager.publicKey, view, stores);
    if (!ix) return view;
    await sendEntryTx(stager, getToken, async () => [ix], { selfPay });
    const fresh = await readTicket(view.address);
    if (!fresh) throw new Error("The prepared entry disappeared.");
    view = fresh;
  }
  throw new Error("Your entry took too many steps to prepare. Cancel it and try again.");
}

/**
 * Prepares an Entry Ticket for the Player's own entry: open it with room for the draw, grow it past one
 * transaction's limit, stage until the draw is complete. Resolves with the complete Ticket (the Pot of the Match).
 * Resume with `resumeTicket` after a reload.
 */
export async function prepareEntryTicket(a: PrepareArgs): Promise<TicketView> {
  const owner = accountOfSigner(a.signer);
  const first = Math.min(a.lines, MAX_INITIAL_TICKET_LINES);
  // the nonce is the Account's next_ticket, read again every time the transaction is built
  let nonce = 0n;
  await sendEntryTx(a.seat ? cosigned(a.signer, a.seat) : a.signer, a.getToken, async (payer, sponsored) => {
    nonce = await readNextTicket(owner);
    return [openTicketIx({ payer, authority: a.signer.publicKey, seatSigner: a.seat?.publicKey, owner, nonce, kind: "entry", game: a.game, target: a.entry, lines: first, sponsored })];
  });
  const address = ticketPda(owner, nonce);
  if (a.lines > first) {
    // grow_ticket is not in the relayer's allow-list: the Player pays this refundable rent
    await sendEntryTx(a.signer, a.getToken, async () => growTicketIxs(a.signer.publicKey, owner, address, a.lines - first), { sponsorable: false });
  }
  const t = await readTicket(address);
  if (!t) throw new Error("The entry could not be prepared. Try again.");
  return restage(a.signer, a.getToken, t, a.onProgress, a.seat);
}

/** Continues staging a Ticket found after a reload. `seat`: the key that opened it, when this device still holds it. */
export async function resumeTicket(signer: ChainSigner, getToken: GetToken, t: TicketView, onProgress?: (s: StagedEntry) => void, seat?: SeatKey): Promise<TicketView> {
  return restage(signer, getToken, t, onProgress, seat);
}

/**
 * A Backing Ticket: the Requester opens it and stages the first lines of the Backer's draw in one transaction (single signer);
 * more staging transactions follow until the draw is complete. `lines` as for `prepareEntryTicket`.
 */
export async function prepareBackingTicket(
  a: Omit<PrepareArgs, "game"> & { game: GameId; backerAccount: PublicKey; offer: PublicKey },
): Promise<TicketView> {
  const requester = a.signer.publicKey;
  const first = Math.min(a.lines, MAX_INITIAL_TICKET_LINES);
  // the Backer's counter numbers a Backing Ticket too; read again every time the transaction is built
  let nonce = 0n;
  await sendEntryTx(a.seat ? cosigned(a.signer, a.seat) : a.signer, a.getToken, async (payer, sponsored) => {
    nonce = await readNextTicket(a.backerAccount);
    const address = ticketPda(a.backerAccount, nonce);
    const open = openTicketIx({ payer, authority: requester, seatSigner: a.seat?.publicKey, owner: a.backerAccount, nonce, kind: "backing", game: a.game, target: a.entry, lines: first, offer: a.offer, sponsored });
    const stores = await readEntryStores(a.backerAccount);
    const plan = planDraw(stores.basket, stores.spill, a.entry, stageLimit(stores) + 0n);
    const stage = stageEntryIx(requester, a.backerAccount, address, STAGE_OPS, await drawRemaining({ steps: plan.steps.slice(0, STAGE_OPS) }));
    return [open, stage];
  });
  const address = ticketPda(a.backerAccount, nonce);
  if (a.lines > first) {
    await sendEntryTx(a.signer, a.getToken, async () => growTicketIxs(requester, a.backerAccount, address, a.lines - first), { sponsorable: false });
  }
  const t = await readTicket(address);
  if (!t) throw new Error("The Backing could not be prepared. Try again.");
  return restage(a.signer, a.getToken, t, a.onProgress);
}

/** Cancels a Ticket: returns the staged lines in batches until it is Cancelled, then closes it (rent back to whoever paid). */
export async function cancelTicket(signer: ChainSigner, getToken: GetToken, t: TicketView, opts: { offer?: PublicKey; onProgress?: (s: StagedEntry) => void } = {}): Promise<void> {
  let view: TicketView | null = t;
  for (let i = 0; i < 40 && view && view.state !== "cancelled"; i++) {
    const current: TicketView = view;
    const sources = [...new Map(current.stagedLines.map((l) => [l.source.toBase58(), l.source])).values()];
    const remaining = await booksFor(sources, current.stagedLines);
    await sendEntryTx(signer, getToken, async () => [cancelTicketIx(signer.publicKey, current.account, current.address, 32, opts.offer, remaining)], { entry: false });
    view = await readTicket(t.address);
    if (view) opts.onProgress?.(stagedEntryState(view));
  }
  if (view && view.state === "cancelled") {
    const closing: TicketView = view;
    const relayer = await relayerKey();
    const sponsored = !!relayer && closing.payer.equals(relayer);
    await sendEntryTx(signer, getToken, async () => [closeTicketIx(signer.publicKey, closing.address, closing.payer, sponsored)], { entry: false });
  }
}

export { sponsoredSend, metaOf };
