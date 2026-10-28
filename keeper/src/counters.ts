import { CURRENT_SIZE } from "../../app/src/lib/chain/account-sizes.ts";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta, type Keypair } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { cashInFeeIx, harvestIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { bookOf, configAddress, economyAddress, keyOf } from "./kit.ts";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, ata, custodyOf, payingAccounts, ratingAccounts, type Custody } from "./kind-pay.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { SIM_SOL_MINT, connReader, dedupe, supplySources, type Reader } from "./supply.ts";
import { simulate } from "./tee.ts";
import { decodeCorePosition } from "./position.ts";

// ---- The fee counters in a Source's book -------------------------------------------------------------------------

const COUNTERS_AT = 8 + 40;
const LINE_LEN = 144;

export const CLASS_PLATFORM = 0;
export const CLASS_STUDIO = 1;
export const CLASS_LEADERBOARD = 2;

/** Whole Gemas in each fee counter of a Source's book account (Platform, Studio, Leaderboard), as of the last time it was touched. */
export function counterAmounts(book: Uint8Array): [bigint, bigint, bigint] {
  const buf = Buffer.from(book.buffer, book.byteOffset, book.byteLength);
  return [0, 1, 2].map((c) => buf.readBigUInt64LE(COUNTERS_AT + c * LINE_LEN + 43)) as [bigint, bigint, bigint];
}

/** What one pass looks at: a few Sources at a time, round robin, so a big list costs the same each pass. */
const PER_PASS = Number(process.env.KEEPER_COUNTERS_PER_PASS ?? 25);
/** Counters worth less than this many Gemas wait (a cash-in costs a transaction). */
export const MIN_GEMAS = BigInt(process.env.KEEPER_COUNTERS_MIN_GEMAS ?? 10);
/** A Source whose counter had nothing to pay is not tried again for this long. */
export const RETRY_MS = Number(process.env.KEEPER_COUNTERS_RETRY_SECS ?? 30 * 60) * 1000;

export interface SourceRow {
  address: PublicKey;
  position: PublicKey;
}

/**
 * The next `n` items after `after` in key order, wrapping, and the key to continue from. Paging by key (not by index) keeps the
 * walk fair when Sources are added or closed between passes.
 */
export function nextSlice<T>(items: T[], after: string | null, n: number, keyOf: (item: T) => string = (item) => String(item)): { slice: T[]; next: string | null } {
  if (!items.length) return { slice: [], next: null };
  const first = after === null ? 0 : items.findIndex((i) => keyOf(i) > after);
  const start = first < 0 ? 0 : first;
  const slice = Array.from({ length: Math.min(n, items.length) }, (_, i) => items[(start + i) % items.length]);
  return { slice, next: keyOf(slice[slice.length - 1]) };
}

/** Code-unit order, the one `nextSlice` pages by: `localeCompare` orders base58 letters by case-folded value and would disagree. */
export const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface CounterDeps {
  list: Lister;
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  simulate(ixs: Parameters<typeof sendIxs>[2]): Promise<string | null>;
  now(): number;
}

export const realCounterDeps = (ctx: Ctx): CounterDeps => ({
  list: connLister(ctx.conn),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  simulate: (ixs) => simulate(ctx.conn, ctx.payer, ixs),
  now: () => Date.now(),
});

const cursors: Record<"harvest" | "cashin" | "batches", string | null> = { harvest: null, cashin: null, batches: null };
export const nextTry = new Map<string, number>();

export interface Candidate {
  source: PublicKey;
  position: PublicKey;
  /** The custody a Solana Position pays from; null for a reported (bridged) Position. */
  custody: Custody | null;
  chain: "solana" | "ethereum" | "hyperEvm";
  /** The core Position id (an EVM Position's first 20 bytes are its vault). */
  positionId: Uint8Array;
  counters: [bigint, bigint, bigint];
}

/** A scan of every Source stays good for this long: the harvest, cash-in and batches jobs of one pass share it. */
const SCAN_TTL_MS = Number(process.env.KEEPER_COUNTERS_SCAN_TTL_SECS ?? 30) * 1000;
const scans = new WeakMap<object, { at: number; rows: Promise<SourceRow[]> }>();

/** Every Source with its Position, sorted by address. One `getProgramAccounts` per pass however many jobs ask. */
export async function sourceRows(ctx: Ctx, d: CounterDeps): Promise<SourceRow[]> {
  const hit = scans.get(ctx);
  if (hit && d.now() - hit.at < SCAN_TTL_MS) return hit.rows;
  const rows = d.list("SourceState", { dataSize: CURRENT_SIZE.sourceState }).then((all) => {
    const out: SourceRow[] = all.map((r) => ({ address: r.pubkey, position: keyOf((ctx.core.coder.accounts.decode("sourceState", r.data) as any).inner.position) }));
    return out.sort((a, b) => byKey(a.address.toBase58(), b.address.toBase58()));
  });
  scans.set(ctx, { at: d.now(), rows });
  rows.catch(() => scans.delete(ctx));
  return rows;
}

/** Sources of Solana Positions whose custody `want` accepts, with the counters of their books, `PER_PASS` of them from the cursor. */
export async function candidates(ctx: Ctx, d: CounterDeps, which: "harvest" | "cashin" | "batches", want: (c: Candidate) => boolean, positive: (counters: [bigint, bigint, bigint]) => boolean): Promise<Candidate[]> {
  const sources = await sourceRows(ctx, d);
  const { slice, next } = nextSlice(sources, cursors[which], PER_PASS, (r) => r.address.toBase58());
  cursors[which] = next;
  const books = await d.read.many(slice.map((s) => bookOf(s.address)));
  const withCounters = slice.flatMap((s, i) => (books[i] && positive(counterAmounts(books[i]!.data)) ? [{ ...s, counters: counterAmounts(books[i]!.data) }] : []));
  const positions = await d.read.many(withCounters.map((s) => s.position));
  const out: Candidate[] = [];
  for (let i = 0; i < withCounters.length; i++) {
    const p = positions[i];
    if (!p) continue;
    const decoded: any = decodeCorePosition(ctx.core, p.data);
    const custody = await custodyOf(ctx.core, d.read, decoded, SIM_SOL_MINT);
    const chain = Object.keys(decoded.inner.sourceChain)[0] as Candidate["chain"];
    const cand: Candidate = { source: withCounters[i].address, position: withCounters[i].position, custody, chain, positionId: Uint8Array.from(decoded.positionId), counters: withCounters[i].counters };
    if (want(cand)) out.push(cand);
  }
  return out;
}

export const due = (key: string, now: number) => (nextTry.get(key) ?? 0) <= now;

// ---- Harvest ---------------------------------------------------------------------------------------------------------

/**
 * Job: `harvest` moves the ready part of each Source's Leaderboard counter into its custody's prize escrow (spec "Prize
 * escrow"), where the Season job turns it into the Season's prize. Permissionless. Only custodies with their escrow on
 * take it, so a Source of a route that is off is left alone. A harvest that has nothing ready is found by a free dry run
 * and that Source is left for `KEEPER_COUNTERS_RETRY_SECS`.
 */
export async function harvestJob(ctx: Ctx, d: CounterDeps = realCounterDeps(ctx), escrowOn: (custody: PublicKey) => Promise<boolean> = (c) => escrowEnabled(ctx, d.read, c)): Promise<number> {
  const on = new Map<string, boolean>();
  const list = (await candidates(ctx, d, "harvest", (c) => !!c.custody, (c) => c[CLASS_LEADERBOARD] >= MIN_GEMAS)) as (Candidate & { custody: Custody })[];
  let actions = 0;
  for (const c of list) {
    const key = `harvest:${c.source.toBase58()}`;
    if (!due(key, d.now())) continue;
    const k = c.custody.address.toBase58();
    if (!on.has(k)) on.set(k, await escrowOn(c.custody.address));
    if (!on.get(k)) continue;
    const supply = await supplySources(ctx.core, d.read, [{ source: c.source, cut: false }]);
    const remaining = dedupe([...ratingAccounts(c.custody), ...supply.metas]);
    const ixs = [await harvestIx(ctx.core, { position: c.position, source: c.source, remaining })];
    const opts: SendOpts = { units: 600_000 };
    const why = await d.simulate(ixs);
    if (why) {
      nextTry.set(key, d.now() + RETRY_MS);
      log("harvest", `source=${shortKey(c.source)}`, `wait: nothing to harvest yet (${why.slice(0, 100)})`);
      continue;
    }
    actions += +(await act(ctx, "harvest", `source=${shortKey(c.source)}`, `harvest (Leaderboard counter ${c.counters[CLASS_LEADERBOARD]} Gemas)`, () => d.send(ixs, opts))).ok;
  }
  return actions;
}

async function escrowEnabled(ctx: Ctx, read: Reader, custody: PublicKey): Promise<boolean> {
  const [info] = await read.many([custody]);
  if (!info) return false;
  const head = info.data.subarray(0, 8);
  const native = Buffer.from((ctx.core.coder.accounts as any).accountDiscriminator("nativeCustody")).equals(head);
  const c: any = ctx.core.coder.accounts.decode(native ? "nativeCustody" : "stakeCustody", info.data);
  return !!c.route.escrowEnabled;
}

// ---- Fee cash-in -----------------------------------------------------------------------------------------------------

/** The instruction that creates `owner`'s associated token account for `mint` unless it already exists. */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  const w = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [w(payer, true, true), w(ata(owner, mint), true), w(owner, false), w(mint, false), w(SystemProgram.programId, false), w(TOKEN_PROGRAM_ID, false)],
    data: Buffer.from([1]),
  });
}

export interface Recipients {
  /** Platform Fee recipient (a TesoroAccount) and its wallet. */
  platform: { account: PublicKey; wallet: PublicKey } | null;
  studio: { account: PublicKey; wallet: PublicKey } | null;
}

/**
 * Job: cashes the covered Platform and Studio Fee counters of every Source in to Tesoro's recipients' wallets (spec stories
 * 37/38, `cash_in_fee`): permissionless, native and staking-token Sources (EVM Sources go through the bridge). The recipient's
 * token account is created first when it is missing. Dry-run first: a counter with nothing ready is left for a while.
 */
export async function cashInJob(ctx: Ctx, d: CounterDeps = realCounterDeps(ctx), recipients: () => Promise<Recipients> = () => readRecipients(ctx, d.read)): Promise<number> {
  const rec = await recipients();
  if (!rec.platform && !rec.studio) {
    log("fees", "-", "no fee recipient set (Config.platform_recipient, EconomyConfig.tesoro_studio)");
    return 0;
  }
  const list = (await candidates(ctx, d, "cashin", (c) => !!c.custody, (c) => (!!rec.platform && c[CLASS_PLATFORM] >= MIN_GEMAS) || (!!rec.studio && c[CLASS_STUDIO] >= MIN_GEMAS))) as (Candidate & { custody: Custody })[];
  let actions = 0;
  for (const c of list) {
    for (const [cls, who] of [[CLASS_PLATFORM, rec.platform], [CLASS_STUDIO, rec.studio]] as const) {
      if (!who || c.counters[cls] < MIN_GEMAS) continue;
      const key = `cashin:${c.source.toBase58()}:${cls}`;
      if (!due(key, d.now())) continue;
      const subject = `source=${shortKey(c.source)}`;
      const supply = await supplySources(ctx.core, d.read, [{ source: c.source, cut: false }]);
      const destination = ata(who.wallet, c.custody.mint);
      const remaining = dedupe([...payingAccounts(c.custody, destination), ...supply.metas]);
      const cash = await cashInFeeIx(ctx.core, { cls, recipientAccount: who.account, position: c.position, source: c.source, remaining });
      const [ataInfo] = await d.read.many([destination]);
      const ixs = ataInfo ? [cash] : [createAtaIdempotentIx(ctx.payer.publicKey, who.wallet, c.custody.mint), cash];
      const why = await d.simulate(ixs);
      if (why) {
        nextTry.set(key, d.now() + RETRY_MS);
        log("fees", subject, `wait: nothing to cash in yet for ${cls === CLASS_PLATFORM ? "Platform" : "Studio"} (${why.slice(0, 100)})`);
        continue;
      }
      actions += +(await act(ctx, "fees", subject, `cash_in_fee ${cls === CLASS_PLATFORM ? "Platform" : "Studio"} (counter ${c.counters[cls]} Gemas)`, () => d.send(ixs, { units: 600_000 }))).ok;
    }
  }
  return actions;
}

async function readRecipients(ctx: Ctx, read: Reader): Promise<Recipients> {
  const [configInfo, economyInfo] = await read.many([configAddress, economyAddress]);
  const walletOf = async (account: PublicKey) => {
    if (account.equals(PublicKey.default)) return null;
    const [info] = await read.many([account]);
    return info ? { account, wallet: keyOf((ctx.core.coder.accounts.decode("tesoroAccount", info.data) as any).authority) } : null;
  };
  const config: any = configInfo ? ctx.core.coder.accounts.decode("config", configInfo.data) : null;
  const economy: any = economyInfo ? ctx.core.coder.accounts.decode("economyConfig", economyInfo.data) : null;
  return { platform: config ? await walletOf(keyOf(config.platformRecipient)) : null, studio: economy ? await walletOf(keyOf(economy.tesoroStudio)) : null };
}

export type { Keypair };
