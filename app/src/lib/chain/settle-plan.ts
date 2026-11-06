import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, VersionedTransaction, type AccountInfo, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { bookPda, ckptPda, TESORO_CORE } from "./basket";
import { matchOverflowPda } from "./overflow";
import { POT_AT, decodeStore, decodeTicketHead, slack, type Store } from "./pot-store";
import { positionBytes } from "./position-size";
import { checkedV0, fitsTx, sizeOf } from "./tx-size";

/**
 * The one planner of a Settling or Refunding Match's `match_chunk` and `close_match`, used by the Player's page and by
 * the keeper (and so by its safety sweep). It reads the Match, works out which Sources the next steps touch, builds the
 * instruction with the accounts they need and sizes the chunk to the transaction and the compute target.
 */

/** The tesoro_core program client (`ctx.core`), which the app and the keeper type differently (two installs of anchor). */
export type Core = { methods: any; coder: any; account: any; programId: any };

export const meta = (pubkey: PublicKey, writable = true): AccountMeta => ({ pubkey, isSigner: false, isWritable: writable });
export const keyOf = (bytes: ArrayLike<number> | PublicKey): PublicKey => (bytes instanceof PublicKey ? bytes : new PublicKey(Uint8Array.from(bytes)));
const pda = (...seeds: (string | Uint8Array)[]): PublicKey => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), TESORO_CORE)[0];
const basketOf = (account: PublicKey) => pda("basket", account.toBuffer());
const spillOf = (account: PublicKey) => pda("spill", account.toBuffer());
const countersOf = (account: PublicKey) => pda("counters", account.toBuffer());
const protectionsOf = (account: PublicKey) => pda("protections", account.toBuffer());
/** Run kinds whose entries came back unplayed (`RunKind::releases_entry`): a Draw or a No-show was played. */
const UNPLAYED = ["cancelled", "abandoned", "gameUpgraded", "byGame"];
const sponsorAddress = pda("sponsor");

/** A Pot's lines, as far as a run walks them. */
export interface PotLines {
  len: number;
  lineAt(i: number): { source: PublicKey; amount: bigint };
}

// ---- The run cursor and the Sources it touches --------------------------------------------------------------------

/** One phase of a Settling or Refunding run, in the order the program walks them. */
export type Phase = { kind: "cuts" | "back"; side: number } | { kind: "surplus"; from: number; to: number };

export interface RunFacts {
  phases: Phase[];
  phaseI: number;
  lineI: number;
  /** Per side, the Gemas still to cut for Platform, Studio and Leaderboard. */
  cutLeft: bigint[][];
}

const num = (v: unknown) => Number((v as { toString(): string }).toString());
/** Anchor decodes tuple variants either as an array or as `{ "0": v }`. */
const first = (v: unknown): number => (Array.isArray(v) ? num(v[0]) : typeof v === "object" && v !== null ? num((v as Record<string, unknown>)["0"] ?? Object.values(v)[0]) : num(v));

/** The decoded `Phase` of the IDL (`{ cuts: [side] }`, `{ back: [side] }`, `{ surplus: { from, to } }`). */
export function phaseOf(raw: Record<string, unknown>): Phase {
  const [name, value] = Object.entries(raw)[0];
  const key = name.toLowerCase();
  if (key === "cuts" || key === "back") return { kind: key, side: first(value) };
  if (key === "surplus") {
    const v = value as { from: unknown; to: unknown };
    return { kind: "surplus", from: num(v.from), to: num(v.to) };
  }
  throw new Error(`unknown phase ${name}`);
}

/** The cursor of a decoded `Run`; null for a Match whose run has not started. */
export function runOf(run: any | null | undefined): RunFacts | null {
  if (!run) return null;
  const n = num(run.nPhases ?? run.n_phases);
  const phases = (run.phases as Record<string, unknown>[]).slice(0, n).map(phaseOf);
  return {
    phases,
    phaseI: num(run.phaseI ?? run.phase_i),
    lineI: num(run.lineI ?? run.line_i),
    cutLeft: (run.cutLeft ?? run.cut_left).map((side: unknown[]) => side.map((v) => BigInt((v as { toString(): string }).toString()))),
  };
}

export interface Ahead {
  source: PublicKey;
  /** A fee is cut from this Source: its SourceState, Position and rate account are needed too. */
  cut: boolean;
}

/**
 * The Sources the next `maxLines` steps touch. A port of `MatchRecord::sources_ahead`
 * (programs/tesoro_core/src/ledger/lifecycle/mod.rs): it walks the same cursor the chunk walks.
 */
export function sourcesAhead(run: RunFacts, pots: (PotLines | null)[], maxLines: number): Ahead[] {
  const out: Ahead[] = [];
  let left = maxLines;
  const push = (source: PublicKey, cut: boolean) => {
    const seen = out.find((o) => o.source.equals(source));
    if (seen) seen.cut ||= cut;
    else out.push({ source, cut });
  };
  let lineI = run.lineI;
  const cutLeft = run.cutLeft.map((s) => [...s]);
  for (let pi = run.phaseI; pi < run.phases.length; pi++) {
    if (left === 0) break;
    const phase = run.phases[pi];
    if (phase.kind === "cuts") {
      const p = pots[phase.side];
      if (!p) continue;
      let avail: bigint | null = null;
      const needs = cutLeft[phase.side];
      for (let k = 0; k < needs.length; k++) {
        while (needs[k] > 0n && left > 0) {
          if (lineI >= p.len) break;
          const l = p.lineAt(lineI);
          const a: bigint = avail ?? l.amount;
          if (a === 0n) {
            lineI++;
            avail = null;
            continue;
          }
          push(l.source, true);
          const take = a < needs[k] ? a : needs[k];
          needs[k] -= take;
          left--;
          if (a === take) {
            lineI++;
            avail = null;
          } else avail = a - take;
        }
      }
      if (needs.some((n) => n > 0n)) break;
      lineI = 0;
    } else {
      const s = phase.kind === "surplus" ? phase.from : phase.side;
      const p = pots[s];
      if (!p) continue;
      while (lineI < p.len && left > 0) {
        const l = p.lineAt(lineI);
        if (l.amount > 0n) {
          push(l.source, false);
          left--;
        }
        lineI++;
      }
      if (lineI < p.len) break;
      lineI = 0;
    }
  }
  return out;
}

/** Players, Backers and an outside Studio that a run credits: the Accounts whose baskets and spills a chunk needs. */
export function creditedAccounts(rec: { a: { player: unknown; funder: unknown }; b?: { player: unknown; funder: unknown } | null; terms: { studioOwner?: unknown; studio_owner?: unknown } }, keyOf: (v: any) => PublicKey): PublicKey[] {
  const keys: PublicKey[] = [keyOf(rec.a.player), keyOf(rec.a.funder)];
  if (rec.b) keys.push(keyOf(rec.b.player), keyOf(rec.b.funder));
  const studio = rec.terms.studioOwner ?? rec.terms.studio_owner;
  if (studio) keys.push(keyOf(studio));
  const out: PublicKey[] = [];
  for (const k of keys) if (!out.some((o) => o.equals(k))) out.push(k);
  return out;
}

// ---- Source books --------------------------------------------------------------------------------------------------

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

/** Pages a fee cut's sync or paid Studio tranche can write; old pages cannot be recreated. */
export async function missingCutPages(read: Reader, ahead: Ahead[]): Promise<{ source: PublicKey; cls: number; pageNo: number; address: PublicKey }[]> {
  const cuts = ahead.filter((a) => a.cut);
  const books = await read.many(cuts.map((a) => bookPda(a.source)));
  const candidates: { source: PublicKey; cls: number; pageNo: number; address: PublicKey }[] = [];
  cuts.forEach((a, i) => {
    const book = books[i];
    if (!book) return;
    bookCheckpointCounts(book.data).forEach((ck, cls) => {
      if (cls === 0 || cls === 2) return;
      // A sync closes up to three segments; the fee cut can then seal a paid Studio segment.
      const first = Math.floor(ck / CKPT_PER_PAGE);
      const last = Math.floor((ck + 3) / CKPT_PER_PAGE);
      for (let pageNo = first; pageNo <= last; pageNo++) candidates.push({ source: a.source, cls, pageNo, address: ckptPda(a.source, cls, pageNo) });
    });
  });
  const pages = await read.many(candidates.map((c) => c.address));
  return candidates.filter((_, i) => !pages[i]);
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
  const books = await read.many(ahead.map((a) => bookPda(a.source)));
  const candidates: { key: PublicKey }[] = [];
  ahead.forEach((a, i) => {
    const book = books[i];
    if (!book) {
      missing.push(a.source);
      return;
    }
    metas.push(meta(bookPda(a.source)));
    for (const { cls, page } of pageCandidates(bookCheckpointCounts(book.data))) candidates.push({ key: ckptPda(a.source, cls, page) });
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
      decoded.push(decodeCorePosition(core, posInfos[i]!.data));
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

/** Decodes a Position account's data with the core coder (camelCase fields), whichever layout it has. */
export const decodeCorePosition = (core: Pick<Core, "coder">, data: Uint8Array): any => core.coder.accounts.decode("positionState", positionBytes(data));

// ---- Instructions --------------------------------------------------------------------------------------------------

/** Runs up to `steps` steps of a Settling or Refunding Match. Anyone may send it. */
export const matchChunkIx = (core: Core, o: { caller: PublicKey; matchState: PublicKey; potA: PublicKey; potB?: PublicKey | null; steps: number; remaining: AccountMeta[] }): Promise<TransactionInstruction> =>
  core.methods
    .matchChunk(o.steps)
    .accountsPartial({ caller: o.caller, matchState: o.matchState, potA: o.potA, potB: o.potB ?? null })
    .remainingAccounts(o.remaining)
    .instruction();

/** Closes a finished Match: remaining = the spill of every room hold with Gemas left, then both Players' counters. */
export const closeMatchIx = (
  core: Core,
  o: { caller: PublicKey; matchState: PublicKey; matchPayer: PublicKey; potA: PublicKey; potAPayer: PublicKey; potB?: PublicKey | null; potBPayer?: PublicKey | null; sponsor?: PublicKey | null; remaining: AccountMeta[] },
): Promise<TransactionInstruction> =>
  core.methods
    .closeMatch()
    .accountsPartial({
      caller: o.caller,
      matchState: o.matchState,
      matchPayer: o.matchPayer,
      potA: o.potA,
      potAPayer: o.potAPayer,
      potB: o.potB ?? null,
      potBPayer: o.potBPayer ?? null,
      sponsor: o.sponsor ?? null,
    })
    .remainingAccounts(o.remaining)
    .instruction();

// ---- Does it fit one transaction -----------------------------------------------------------------------------------

export { MAX_TX_BYTES, MAX_TX_ACCOUNTS as MAX_ACCOUNTS } from "./tx-size";

/** What sizing a transaction needs to know: the compute limit it asks for and the lookup tables it compiles with. */
export interface FitOpts {
  units?: number;
  tables?: AddressLookupTableAccount[];
}

const withUnits = (ixs: TransactionInstruction[], opts: FitOpts) => (opts.units ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units }), ...ixs] : ixs);

/** The v0 transaction of `ixs`; refused (`TxTooLarge`, naming the instructions) when it would not fit. */
export function compileTx(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], opts: FitOpts = {}): VersionedTransaction {
  return new VersionedTransaction(checkedV0(payer, blockhash, withUnits(ixs, opts), opts.tables));
}

/** Serialized size in bytes with every signature, as the network counts it. */
export const wireSize = (payer: PublicKey, ixs: TransactionInstruction[], opts: FitOpts = {}): number => sizeOf(payer, withUnits(ixs, opts), opts).bytes;

/** Accounts a compiled transaction names, counting those read through lookup tables. */
export const accountCount = (payer: PublicKey, ixs: TransactionInstruction[], opts: FitOpts = {}): number => sizeOf(payer, withUnits(ixs, opts), opts).accounts;

/** True when `ixs` fit one transaction: at most 1,232 bytes and 64 accounts. */
export const fits = (payer: PublicKey, ixs: TransactionInstruction[], opts: FitOpts = {}) => fitsTx(payer, withUnits(ixs, opts), opts);

// ---- A Match and its pots -------------------------------------------------------------------------------------------

export type Stage = "open" | "active" | "settling" | "refunding" | "closed";

/** A Match opened by `opener` as its `n`th. */
export interface MatchRef {
  opener: PublicKey;
  n: bigint;
}
export const matchRefOf = (id: { opener: ArrayLike<number> | PublicKey; n: { toString(): string } }): MatchRef => ({ opener: keyOf(id.opener), n: BigInt(id.n.toString()) });

/** A decoded `MatchState` with the fields the planner reads named. */
export interface MatchView {
  address: PublicKey;
  ref: MatchRef;
  inner: any;
  stage: Stage;
  pots: [PublicKey, PublicKey];
  payer: PublicKey;
  /** The Accounts whose spill still holds slots for this Match (`left` > 0); empty before the room hold existed. */
  room: { account: PublicKey; left: number }[];
}

export function viewOf(address: PublicKey, account: any): MatchView {
  const inner = account.inner;
  return {
    address,
    ref: matchRefOf(inner.id),
    inner,
    stage: Object.keys(inner.stage)[0].toLowerCase() as Stage,
    pots: [keyOf(account.pots[0]), keyOf(account.pots[1])],
    payer: keyOf(account.payer),
    room: ((account.room ?? []) as { account: ArrayLike<number>; left: number }[]).filter((r) => r.left > 0).map((r) => ({ account: keyOf(r.account), left: r.left })),
  };
}

export interface Loaded {
  view: MatchView;
  pots: (Buffer | null)[];
  stores: (Store | null)[];
}

export async function loadMatch(read: Reader, view: MatchView): Promise<Loaded> {
  const joined = !!view.inner.b;
  const infos = await read.many(joined ? view.pots : [view.pots[0]]);
  const pots = [infos[0]?.data ?? null, joined ? (infos[1]?.data ?? null) : null];
  const stores = pots.map((p) => (p ? decodeStore(p, POT_AT) : null));
  return { view, pots, stores };
}

// ---- Chunks ---------------------------------------------------------------------------------------------------------

/** Steps one chunk starts with: more steps mean fewer transactions but more accounts in each. */
export const CHUNK_STEPS = Number(process.env.KEEPER_CHUNK_STEPS ?? 6);
/** Compute units asked for a chunk (the limit of its transaction; what it uses is held under CHUNK_CU_TARGET). */
export const CHUNK_UNITS = 400_000;
/**
 * A chunk's simulated compute must stay under this: the 140,000 target of ticket 42 less a margin for the state moving
 * between simulation and landing. Loading a chunk's accounts costs 40-70k and a step 6-33k, so no fixed step count holds
 * it: the planner simulates the chunk and takes fewer steps until it fits.
 */
export const CHUNK_CU_TARGET = Number(process.env.KEEPER_CHUNK_CU_TARGET ?? 125_000);

export interface ChunkPlan {
  ix: TransactionInstruction;
  steps: number;
  /** Sources the steps touch whose book is missing: the chunk would refuse them. */
  missing: PublicKey[];
  credited: PublicKey[];
}

/** Builds the next chunk of a Settling or Refunding Match with as many steps as fit one transaction (down to 1). `fitsOne` says whether an instruction fits. */
export async function planChunk(core: Core, read: Reader, caller: PublicKey, l: Loaded, steps: number, fitsOne: (ix: TransactionInstruction) => boolean): Promise<ChunkPlan | null> {
  const run = runOf(l.view.inner.run);
  if (!run) return null;
  const credited = creditedAccounts(l.view.inner, keyOf);
  const stores = await read.many(credited.flatMap((a) => [basketOf(a), spillOf(a)]));
  const storeMetas: AccountMeta[] = credited.flatMap((a, i) => (stores[2 * i] && stores[2 * i + 1] ? [meta(basketOf(a)), meta(spillOf(a))] : []));
  // An Account the Match made an overflow record for (its stores had no room at join): a credit that finds no slot lands there.
  const recordKeys = credited.map((a) => matchOverflowPda(a, l.view.ref));
  const records = await read.many(recordKeys);
  records.forEach((r, i) => {
    if (r) storeMetas.push(meta(recordKeys[i]));
  });
  for (let n = Math.max(1, steps); ; n = Math.max(1, Math.floor(n / 2))) {
    const ahead = sourcesAhead(run, l.stores, n);
    const supply = await supplySources(core, read, ahead);
    const remaining = dedupe([...storeMetas, ...supply.metas]);
    const ix = await matchChunkIx(core, { caller, matchState: l.view.address, potA: l.view.pots[0], potB: l.view.inner.b ? l.view.pots[1] : null, steps: n, remaining });
    if (n === 1 || fitsOne(ix)) return { ix, steps: n, missing: supply.missing, credited };
  }
}

/** Accounts of `credited` whose basket and spill have no room left: the ones a blocked chunk is waiting on. */
export async function fullAccounts(read: Reader, credited: PublicKey[]): Promise<PublicKey[]> {
  const infos = await read.many(credited.flatMap((a) => [basketOf(a), spillOf(a)]));
  return credited.filter((_, i) => {
    const [b, s] = [infos[2 * i], infos[2 * i + 1]];
    return !!b && !!s && slack(decodeStore(b.data), decodeStore(s.data)) <= 0;
  });
}

/**
 * The remaining accounts of `close_match`: the spill of every Account that still holds room, both Players' counters, and for a
 * refund (not a Draw or a No-show) each side's funder's Protections, so the entry counted on its Entry Limit is given back.
 */
export function closeRemaining(view: MatchView): AccountMeta[] {
  const out: AccountMeta[] = [];
  const add = (k: PublicKey) => {
    if (!out.some((m) => m.pubkey.equals(k))) out.push(meta(k));
  };
  for (const r of view.room) add(spillOf(r.account));
  add(countersOf(keyOf(view.inner.a.player)));
  if (view.inner.b) add(countersOf(keyOf(view.inner.b.player)));
  const kind = view.inner.run?.kind ? Object.keys(view.inner.run.kind)[0] : null;
  if (kind && UNPLAYED.includes(kind)) for (const side of [view.inner.a, view.inner.b]) if (side) add(protectionsOf(keyOf(side.funder)));
  return out;
}

export async function closeIx(core: Core, read: Reader, caller: PublicKey, l: Loaded) {
  const { view } = l;
  const joined = !!view.inner.b;
  const head = (i: number) => (l.pots[i] ? decodeTicketHead(l.pots[i]!).payer : null);
  const sponsorInfo = (await read.many([sponsorAddress]))[0];
  return closeMatchIx(core, {
    caller,
    matchState: view.address,
    matchPayer: view.payer,
    potA: view.pots[0],
    potAPayer: head(0)!,
    potB: joined ? view.pots[1] : null,
    potBPayer: joined ? head(1) : null,
    sponsor: sponsorInfo ? sponsorAddress : null,
    remaining: closeRemaining(view),
  });
}

/** What sizing a chunk reaches the chain through. */
export interface SizeEnv {
  core: Core;
  read: Reader;
  caller: PublicKey;
  /** Whether the instruction fits one transaction (bytes and accounts) as the sender will compile it. */
  fitsOne(ix: TransactionInstruction): boolean;
  /** Compute units a dry run of the instruction uses; absent or null when it cannot be measured (the chunk is then sent as planned). */
  simulate?(ix: TransactionInstruction): Promise<number | null>;
  log?(message: string): void;
}

/**
 * Plans the next chunk with as many steps as fit the transaction AND the compute target: simulates it and, while it
 * uses more than CHUNK_CU_TARGET, plans again with the steps the measured cost allows (at least one fewer). A chunk
 * whose steps are cut short is harmless: the Match record keeps the progress and the next chunk resumes.
 */
export async function planSizedChunk(env: SizeEnv, l: Loaded): Promise<ChunkPlan | null> {
  let steps = CHUNK_STEPS;
  for (;;) {
    const plan = await planChunk(env.core, env.read, env.caller, l, steps, env.fitsOne);
    if (!plan || !env.simulate) return plan;
    const used = await env.simulate(plan.ix);
    if (used === null || used <= CHUNK_CU_TARGET) return plan;
    if (plan.steps <= 1) {
      env.log?.(`WARN a one-step chunk simulates at ${used} CU, over the ${CHUNK_CU_TARGET} target`);
      return plan;
    }
    steps = Math.max(1, Math.min(plan.steps - 1, Math.floor((plan.steps * CHUNK_CU_TARGET) / used)));
    env.log?.(`chunk of ${plan.steps} steps simulates at ${used} CU: trying ${steps}`);
  }
}
