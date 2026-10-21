/**
 * Entering a Match on baskets (tesoro_core `open_match` / `join_match`, tickets 04, 09, 09b, 18).
 *
 * Pure planning (`previewEntry`, `joinGrowPlan`, `backingLimit`) is separate from the builders and the
 * senders, so the preview the Player sees is the draw the program makes (same merged order, see draw.ts)
 * and the tests need no network.
 *
 * Sequences (economy-notes/room-and-holds.md):
 *  - OPEN, up to 16 lines: one transaction `[open_match]`, Player and `payer` sign. No grow whatever the fullness of
 *    the stores. More lines: an Entry Ticket first (ticket.ts), then `[open_match]` with the complete Ticket as Pot.
 *  - JOIN: `[grow_store_sponsored…, join_match]`. The grows are best effort (they buy the holds that make the settle
 *    independent of anyone's room); a join is never refused for room.
 * Both go through the relayer when it can pay and fall back to the Player paying.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import coreIdl from "./idl/tesoro_core.json";
import {
  CLASS_GENERAL,
  MAX_GROW_LINES,
  basketPda,
  bookPda,
  countersPda,
  decodeStore,
  freeGemas,
  matchPda,
  playableTotal,
  sponsorPda,
  spillPda,
  ticketPda,
  type Line,
  type Store,
} from "./basket";
import { decodeBook } from "./book";
import { coreIx as rawCoreIx, metaOf, type AccountsByName } from "./core-ix";
import { type DemoError, ensureSol, type GetToken } from "./demo-client";
import { DrawError, bookAccounts, planDraw, sourcesTouched, type DrawPlan } from "./draw";
import { gameAccounts, pairPda } from "./game-record";
import { GAME_IDS } from "./games";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { protectionsPda } from "./native";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

export { DrawError };

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const snakeKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
/** `coreIx` with camelCase names for accounts and arguments (the IDL's are snake_case). */
export const coreIx = (name: string, accounts: AccountsByName, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []) => rawCoreIx(name, snakeKeys(accounts), snakeKeys(args), remaining);

const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(coreIdl.address))[0];
const accountOf = (authority: PublicKey) => BlockPuzzleChain.coreAccount(authority);
const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does the deployed IDL name this account on this instruction (09b renames and adds accounts)? */
const idlHas = (ix: string, account: string): boolean =>
  (coreIdl.instructions as { name: string; accounts: { name: string }[] }[]).find((i) => i.name === ix)?.accounts.some((a) => a.name === account) ?? false;

// ---- stores --------------------------------------------------------------------------------

/** An Account's basket and spill, and its Match counter, as one entry reads them. */
export interface EntryStores {
  account: PublicKey;
  basket: Store;
  spill: Store;
  /** `AccountCounters.next_match`: the `n` the next Match this Account opens gets (0 before the counter exists). */
  nextMatch: bigint;
}

const emptyStore = (account: PublicKey): Store => ({
  header: { version: 3, bump: 0, flags: 0, len: 0, first: 0, account, ownTotal: 0n, wonTotal: 0n, feeTotal: 0n, reservedTotal: 0n, sponsoredLamports: 0n, ticketNeed: 0n, roomReserved: 0, capacity: 0 },
  lines: [],
});

const tryStore = (data: Uint8Array | undefined, account: PublicKey): Store => {
  try {
    return data ? decodeStore(data) : emptyStore(account);
  } catch {
    return emptyStore(account);
  }
};

/** Counter layout: discriminator 8, bump 1, `next_match` u64. */
export const nextMatchOf = (data: Uint8Array | undefined): bigint =>
  data && data.length >= 17 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(9, true) : 0n;

export async function readEntryStores(account: PublicKey, conn: Pick<Connection, "getMultipleAccountsInfo"> = getChain().base): Promise<EntryStores> {
  const [b, s, c] = await conn.getMultipleAccountsInfo([basketPda(account), spillPda(account), countersPda(account)], "confirmed");
  return { account, basket: tryStore(b?.data, account), spill: tryStore(s?.data, account), nextMatch: nextMatchOf(c?.data) };
}

// ---- preview -------------------------------------------------------------------------------

/** Rent of a Ticket / Pot account holding `lines` lines: 8 + 160 head + 128 header + 144 per line, at 6,960 lamports a byte (plus the 128 account overhead). */
export const potLen = (lines: number) => 8 + 160 + 128 + 144 * lines;
export const potRentLamports = (lines: number) => BigInt(potLen(lines) + 128) * 6_960n;

/** Largest Ticket `open_ticket` can create in one go (account creation by CPI is capped at 10,240 bytes). */
export const MAX_INITIAL_TICKET_LINES = Math.floor((10_240 - (8 + 160) - 128) / 144);

/** Slots a Ticket gets above the lines the draw needs: restages and splits. */
export const TICKET_SLACK_LINES = 2;

export interface EntryStep {
  dueAt: number;
  isOwn: boolean;
  take: bigint;
  whole: boolean;
  source: PublicKey;
}

export interface EntryPreview {
  entry: bigint;
  /** The program's draw, in order. */
  steps: EntryStep[];
  /** Own-sourced Gemas drawn, and won ones. */
  ownGemas: bigint;
  wonGemas: bigint;
  /** Earliest and latest planned repayment among the lines drawn (unix seconds). */
  dueFirst: number | null;
  dueLast: number | null;
  /** Gemas drawn from lines due by `fastBy` (default: all lines due by the median line is not what the Player thinks of; the UI picks the cut). */
  gemasDueBy(unixSecs: number): bigint;
  lineCount: number;
  /** More lines than one transaction draws: the entry goes through an Entry Ticket. */
  needsTicket: boolean;
  /** `pot_lines` of a direct `open_match`. */
  potLines: number;
  /** Lines of the Ticket's storage (the draw's lines plus slack). */
  ticketLines: number;
  /** Stage transactions the Ticket takes (32 lines each). */
  stageTxs: number;
  /** Refundable rent of the Pot account, paid by the relayer when it sponsors. */
  potRentLamports: bigint;
  /** Sources whose book the draw touches. */
  sourcesTouched: PublicKey[];
  free: bigint;
  /** The draw itself (for the builders). */
  plan: DrawPlan;
}

export const STAGE_OPS = 32;

/** Gemas a Backing draw may reach: it may use what its own Offer reserved, never another Offer's (`draw_backing_direct`). */
export function backingLimit(stores: Pick<EntryStores, "basket" | "spill">, amount: bigint): bigint {
  const reserved = stores.basket.header.reservedTotal;
  const total = playableTotal(stores.basket, stores.spill);
  const held = reserved > amount ? reserved - amount : 0n;
  return total > held ? total - held : 0n;
}

/**
 * The entry as the program will draw it. `backing`: the lines are the Backer's and the draw may use their Offer's
 * reservation. Throws `DrawError` ("zero" / "insufficient") when it cannot be made.
 */
export function previewEntry(stores: Pick<EntryStores, "basket" | "spill">, entry: bigint, opts: { backing?: boolean } = {}): EntryPreview {
  const plan: DrawPlan = planDraw(stores.basket, stores.spill, entry, opts.backing ? backingLimit(stores, entry) : undefined);
  const steps: EntryStep[] = plan.steps.map((s) => ({ dueAt: Number(s.line.dueAt), isOwn: s.line.side === 0, take: s.take, whole: s.whole, source: s.line.source }));
  const sum = (own: boolean) => steps.filter((s) => s.isOwn === own).reduce((a, s) => a + s.take, 0n);
  const ticketLines = Math.max(1, plan.potLines + TICKET_SLACK_LINES);
  return {
    entry,
    steps,
    ownGemas: sum(true),
    wonGemas: sum(false),
    dueFirst: steps.length ? Math.min(...steps.map((s) => s.dueAt)) : null,
    dueLast: steps.length ? Math.max(...steps.map((s) => s.dueAt)) : null,
    gemasDueBy: (t) => steps.filter((s) => s.dueAt <= t).reduce((a, s) => a + s.take, 0n),
    lineCount: steps.length,
    needsTicket: plan.needsTicket,
    potLines: plan.potLines,
    ticketLines,
    stageTxs: Math.max(1, Math.ceil(steps.length / STAGE_OPS)),
    potRentLamports: potRentLamports(plan.needsTicket ? ticketLines : plan.potLines),
    sourcesTouched: sourcesTouched(plan),
    free: plan.free,
    plan,
  };
}

/** Free Gemas of the stores (playable minus Offer reservations and an open Ticket's need). */
export const freeOf = (s: Pick<EntryStores, "basket" | "spill">) => freeGemas(s.basket, s.spill);

// ---- remaining accounts of a draw ------------------------------------------------------------

/** The books (and the checkpoint pages their stale lines read) of `sources`, writable, as remaining accounts. `lines` are the lines that will be edited. */
export async function booksFor(sources: PublicKey[], lines: Line[], conn: Pick<Connection, "getMultipleAccountsInfo"> = getChain().base): Promise<AccountMeta[]> {
  if (sources.length === 0) return [];
  const infos = await conn.getMultipleAccountsInfo(sources.map(bookPda), "confirmed");
  const keys = new Map<string, PublicKey>();
  sources.forEach((source, i) => {
    let ck: (c: number) => number = () => 0;
    try {
      const book = infos[i] ? decodeBook(infos[i]!.data) : null;
      if (book) ck = (c) => book.classes[c]?.ck ?? 0;
    } catch {
      // an unreadable book: pass the book alone, the program reports what it needs
    }
    for (const k of bookAccounts(source, lines.filter((l) => l.source.equals(source)), ck)) keys.set(k.toBase58(), k);
  });
  return [...keys.values()].map((k) => metaOf(k, true));
}

/** The Source books a draw touches (a split line, a basket and spill line of one key), as remaining accounts. */
export async function drawRemaining(plan: Pick<DrawPlan, "steps">, conn: Pick<Connection, "getMultipleAccountsInfo"> = getChain().base): Promise<AccountMeta[]> {
  return booksFor(sourcesTouched(plan as DrawPlan), plan.steps.map((s) => s.line), conn);
}

// ---- sending -------------------------------------------------------------------------------

let relayerCache: { key: PublicKey | null; at: number } | null = null;

/** The relayer's key, or null when free transactions are paused or unreachable. Cached for a minute. */
export async function relayerKey(): Promise<PublicKey | null> {
  if (relayerCache && Date.now() - relayerCache.at < 60_000) return relayerCache.key;
  let key: PublicKey | null = null;
  try {
    const s = await sponsorStatus();
    key = s.paused ? null : new PublicKey(s.relayer);
  } catch {
    key = null;
  }
  relayerCache = { key, at: Date.now() };
  return key;
}

/** Limits the relayer enforces per Account/day: the same instructions may be sent with the Player paying. */
const SELF_PAY_CODES = new Set(["account-limit", "pair-limit", "global-limit", "total-limit", "too-many-failures", "too-many-cycles", "sponsor-paused", "sponsor-empty"]);
export const mayPayYourself = (e: unknown) => e instanceof SponsorError && (e.selfPay || SELF_PAY_CODES.has(e.code) || e.status === 429);

/**
 * Sends one transaction. `build(payer)` makes the instructions with `payer` in the slots the relayer may fill; with a
 * relayer the transaction is sponsored, else (or when the relayer refuses for a reason that is not the Player's) the Player
 * pays: wallet SOL is checked first. `sponsorable: false` skips the relayer (shapes its allow-list does not know).
 */
export async function sendEntryTx(
  signer: ChainSigner,
  getToken: GetToken,
  build: (payer: PublicKey, sponsored: boolean) => Promise<TransactionInstruction[]>,
  opts: { sponsorable?: boolean } = {},
): Promise<{ sig: string; sponsored: boolean }> {
  const relayer = opts.sponsorable === false ? null : await relayerKey();
  if (relayer && signer.signSerialized) {
    try {
      return { sig: await sponsoredSend(signer, getToken, await build(relayer, true)), sponsored: true };
    } catch (e) {
      if (!mayPayYourself(e)) throw e;
    }
  }
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS).catch((e: DemoError) => {
    if (e.code !== "error") throw e;
  });
  return { sig: await getChain().sendBase(signer, await build(signer.publicKey, false)), sponsored: false };
}

// ---- Match refs ------------------------------------------------------------------------------

/** A Match: the opener's Account and the opener's counter value. */
export interface MatchRef {
  opener: PublicKey;
  n: bigint;
}
export const matchAddress = (m: MatchRef) => matchPda(m.opener, m.n);
export const matchRefKey = (m: MatchRef) => `${m.opener.toBase58()}-${m.n}`;

/** A Backing the Player enters under: the accepted Offer and whose Account funds the entry. */
export interface BackingRef {
  offer: PublicKey;
  backerAccount: PublicKey;
}

const potNonce = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
export { potNonce };

/** The pot of one side: a fresh address, or a complete Ticket. */
export interface PotRef {
  address: PublicKey;
  nonce: bigint;
  lines: number;
  /** A complete Ticket (not fresh): `pot_lines` is then ignored by the program. */
  ticket: boolean;
}

export const freshPot = (funder: PublicKey, lines: number): PotRef => {
  const nonce = potNonce();
  return { address: ticketPda(funder, nonce), nonce, lines, ticket: false };
};

const backerAccounts = (b: BackingRef | undefined) =>
  b
    ? {
        offer: b.offer,
        backerAccount: b.backerAccount,
        backerCounters: countersPda(b.backerAccount),
        backerProtections: protectionsPda(b.backerAccount),
        backerBasket: basketPda(b.backerAccount),
        backerSpill: spillPda(b.backerAccount),
      }
    : {};

// ---- open ----------------------------------------------------------------------------------

export interface OpenArgs {
  payer: PublicKey;
  player: PublicKey;
  game: GameId;
  entry: bigint;
  /** `n` of the new Match: the opener's counter. */
  n: bigint;
  challenge: boolean;
  /** Trading Duel asset (0 SOL, 1 ETH, 2 HYPE); 0 for every other Game. */
  asset: number;
  pot: PotRef;
  backing?: BackingRef;
  remaining?: AccountMeta[];
}

/** `open_match`. `player` is the wallet (authority). */
export function openMatchIx(a: OpenArgs): TransactionInstruction {
  const account = accountOf(a.player);
  const game = GAME_IDS[a.game];
  return coreIx(
    "open_match",
    {
      payer: a.payer,
      playerAuthority: a.player,
      config: pda("config"),
      economy: pda("economy"),
      ...gameAccounts(game),
      playerAccount: account,
      counters: countersPda(account),
      protections: protectionsPda(account),
      basket: basketPda(account),
      spill: spillPda(account),
      pot: a.pot.address,
      matchState: matchPda(account, a.n),
      systemProgram: SystemProgram.programId,
      ...backerAccounts(a.backing),
    },
    { game, entry: new BN(a.entry.toString()), n: new BN(a.n.toString()), potNonce: new BN(a.pot.nonce.toString()), challenge: a.challenge, asset: a.asset, potLines: a.pot.lines },
    a.remaining ?? [],
  );
}

// ---- join ----------------------------------------------------------------------------------

/** What a join reads of the Match: who plays and funds each side, the Pot sizes, the Studio, what is held. */
export interface JoinFacts {
  game: PublicKey;
  openerPlayer: PublicKey;
  openerFunder: PublicKey;
  /** Pot lines of side A (the opener's). */
  potLinesA: number;
  /** Holds already kept in the spill for each Account (`MatchState.room`), by base58 key. */
  room: Map<string, number>;
  /** The Studio's Account when it is not Tesoro itself (its fee line lands in its basket). */
  outsideStudio: PublicKey | null;
}

export function joinFactsOf(state: any): JoinFacts {
  const inner = state.inner;
  const room = new Map<string, number>();
  for (const r of (state.room ?? []) as { account: number[]; left: number }[]) {
    const k = pk(r.account);
    if (!k.equals(PublicKey.default) && r.left > 0) room.set(k.toBase58(), (room.get(k.toBase58()) ?? 0) + r.left);
  }
  const studio = inner.terms?.studioOwner;
  return {
    game: pk(inner.game),
    openerPlayer: pk(inner.a.player),
    openerFunder: pk(inner.a.funder),
    potLinesA: Number(inner.potLines?.[0] ?? 0),
    room,
    outsideStudio: studio ? pk(studio) : null,
  };
}

export interface GrowNeed {
  account: PublicKey;
  /** Lines to add to this Account's spill, at most `MAX_GROW_LINES` per instruction. */
  extraLines: number;
}

interface HoldStores {
  basket: Store;
  spill: Store;
}

/**
 * The spill growth that buys each Account's hold for a join (room-and-holds.md): per Account K among the opener, the
 * opener's funder, the joiner, the joiner's funder and an outside Studio (equal keys once; a Studio that also plays doubles its need),
 * `want = potLinesA + potLinesB + 2`, `left` = its share in `MatchState.room`, `slack` = free slots of basket + spill beyond the
 * spill's held ones. Grow by `max(0, want - left - slack)`.
 */
export function joinGrowPlan(facts: JoinFacts, potLinesB: number, joiner: PublicKey, joinerFunder: PublicKey, stores: (account: PublicKey) => HoldStores | undefined): GrowNeed[] {
  const base = facts.potLinesA + potLinesB + 2;
  const roles = [facts.openerPlayer, facts.openerFunder, joiner, joinerFunder];
  const unique = [...new Map(roles.map((k) => [k.toBase58(), k])).values()];
  const studio = facts.outsideStudio;
  const studioPlays = studio ? unique.some((k) => k.equals(studio)) : false;
  const accounts = studio && !studioPlays ? [...unique, studio] : unique;
  const out: GrowNeed[] = [];
  for (const k of accounts) {
    const st = stores(k);
    if (!st) continue;
    const want = base * (studio && studioPlays && k.equals(studio) ? 2 : 1);
    const left = facts.room.get(k.toBase58()) ?? 0;
    const free = st.basket.header.capacity - st.basket.header.len + (st.spill.header.capacity - st.spill.header.len) - st.spill.header.roomReserved;
    const extra = want - left - Math.max(0, free);
    if (extra > 0) out.push({ account: k, extraLines: extra });
  }
  return out;
}

/** `grow_store_sponsored` instructions for a spill growth, split at `MAX_GROW_LINES`. The relayer signs. */
export function growSpillIxs(relayer: PublicKey, need: GrowNeed): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  for (let left = need.extraLines; left > 0; left -= MAX_GROW_LINES) {
    out.push(
      coreIx("grow_store_sponsored", { relayer, sponsor: sponsorPda(), account: need.account, basket: basketPda(need.account), spill: spillPda(need.account) }, { which: { Spill: {} }, extraLines: Math.min(left, MAX_GROW_LINES) }),
    );
  }
  return out;
}

export interface JoinArgs {
  payer: PublicKey;
  player: PublicKey;
  match: MatchRef;
  facts: Pick<JoinFacts, "game" | "openerPlayer" | "openerFunder">;
  pot: PotRef;
  backing?: BackingRef;
  remaining?: AccountMeta[];
}

/** `join_match` (09b accounts when the IDL has them). */
export function joinMatchIx(a: JoinArgs): TransactionInstruction {
  const account = accountOf(a.player);
  const accounts: Record<string, PublicKey | undefined> = {
    payer: a.payer,
    playerAuthority: a.player,
    playerAccount: account,
    counters: countersPda(account),
    protections: protectionsPda(account),
    basket: basketPda(account),
    spill: spillPda(account),
    pot: a.pot.address,
    matchState: matchPda(a.match.opener, a.match.n),
    openerProtections: protectionsPda(a.facts.openerPlayer),
    openerSpill: spillPda(a.facts.openerPlayer),
    openerFunderSpill: spillPda(a.facts.openerFunder),
    pair: pairPda(a.facts.openerPlayer, account),
    gameRecord: gameAccounts(a.facts.game).gameRecord,
    gameProgram: a.facts.game,
    programData: gameAccounts(a.facts.game).programData,
    systemProgram: SystemProgram.programId,
    ...backerAccounts(a.backing),
  };
  if (idlHas("join_match", "opener_basket")) {
    accounts.openerBasket = basketPda(a.facts.openerPlayer);
    accounts.openerFunderBasket = basketPda(a.facts.openerFunder);
  }
  return coreIx("join_match", accounts, { potNonce: new BN(a.pot.nonce.toString()), potLines: a.pot.lines }, a.remaining ?? []);
}

/** Basket and spill of an outside Studio, passed so its fee line gets a hold (without them the Account gets none). */
export const studioRemaining = (studio: PublicKey | null): AccountMeta[] => (studio ? [metaOf(basketPda(studio), true), metaOf(spillPda(studio), true)] : []);

/**
 * The instructions of a join transaction: the best-effort grows (they need the relayer, so only when sponsored), then the join.
 * Grows beyond what one transaction carries (`maxGrows`) are returned apart in `earlier`, to send first.
 */
export function joinTransaction(
  sponsored: boolean,
  relayer: PublicKey | null,
  needs: GrowNeed[],
  join: TransactionInstruction,
  maxGrows = 4,
): { earlier: TransactionInstruction[][]; main: TransactionInstruction[] } {
  if (!sponsored || !relayer) return { earlier: [], main: [join] };
  const grows = needs.flatMap((n) => growSpillIxs(relayer, n));
  const earlier: TransactionInstruction[][] = [];
  while (grows.length > maxGrows) earlier.push(grows.splice(0, 5));
  return { earlier, main: [...grows, join] };
}

/** Reads `MatchState` (null when it does not exist). */
export async function readMatchState(m: MatchRef): Promise<any | null> {
  return getChain().core.account.matchState.fetchNullable(matchAddress(m));
}

export { sleep, CLASS_GENERAL };
export const metaWritable = (k: PublicKey): AccountMeta => metaOf(k, true);
