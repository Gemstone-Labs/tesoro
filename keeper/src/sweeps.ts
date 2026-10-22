import { PublicKey, type Keypair } from "@solana/web3.js";
import { clearRaised, raise } from "./alerts.ts";
import { act, log, type Ctx } from "./act.ts";
import { closePairIx, closeReceiptIx, refreshListingIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { gameRecordOf, keyOf, pairAddress, programDataOf } from "./kit.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { connReader, type Reader } from "./supply.ts";
import { simulate } from "./tee.ts";

/** A settlement receipt is kept this long (RECEIPT_KEEP_SECS of tesoro_core). */
export const RECEIPT_KEEP_SECS = 14 * 24 * 3600;
/** A pair counter's window (PAIR_WINDOW_SECS of tesoro_core). */
export const PAIR_WINDOW_SECS = 24 * 3600;
const PER_TX = 6;
const PER_PASS = 30;

export interface SweepDeps {
  list: Lister;
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  simulate(ixs: Parameters<typeof sendIxs>[2]): Promise<string | null>;
}

export const realSweepDeps = (ctx: Ctx): SweepDeps => ({
  list: connLister(ctx.conn),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  simulate: (ixs) => simulate(ctx.conn, ctx.payer, ixs),
});

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

// ---- Pairs -------------------------------------------------------------------------------------------------------------

/** Pairs (opener Account, joiner Account) of Matches seen, whose counter may still exist. Fed by the history scan. */
export const seenPairs = new Map<string, { opener: PublicKey; joiner: PublicKey }>();
const PAIR_CAP = 5000;

export const notePair = (opener: string, joiner: string) => {
  seenPairs.set(`${opener}:${joiner}`, { opener: new PublicKey(opener), joiner: new PublicKey(joiner) });
  while (seenPairs.size > PAIR_CAP) seenPairs.delete(seenPairs.keys().next().value!);
};

export interface PairRow {
  opener: PublicKey;
  joiner: PublicKey;
  address: PublicKey;
  payer: PublicKey;
  windowStart: number;
}

export const pairsToClose = (rows: PairRow[], now: number) => rows.filter((p) => now >= p.windowStart + PAIR_WINDOW_SECS);

/** Job: closes receipts older than 14 days and pair counters whose 24 h window ended, so their rent comes back. */
export async function sweepJob(ctx: Ctx, d: SweepDeps = realSweepDeps(ctx)): Promise<number> {
  let actions = 0;
  const receipts = oldReceipts((await d.list("SettlementReceipt")).map((r) => receiptOf(r.pubkey, ctx.core.coder.accounts.decode("settlementReceipt", r.data))), ctx.now).slice(0, PER_PASS);
  for (const group of groupsOf(receipts, PER_TX)) {
    const r = await act(ctx, "sweep", `receipts=${group.length}`, `close_receipt x${group.length} (14 days old)`, async () =>
      d.send(await Promise.all(group.map((g) => closeReceiptIx(ctx.core, { caller: ctx.payer.publicKey, receipt: g.address, payer: g.payer }))), {}),
    );
    actions += +r.ok;
  }

  const seen = [...seenPairs.values()];
  if (seen.length) {
    const infos = await d.read.many(seen.map((p) => pairAddress(p.opener, p.joiner)));
    const rows: PairRow[] = [];
    seen.forEach((p, i) => {
      const info = infos[i];
      if (!info) {
        seenPairs.delete(`${p.opener.toBase58()}:${p.joiner.toBase58()}`);
        return;
      }
      const s: any = ctx.core.coder.accounts.decode("pairState", info.data);
      rows.push({ ...p, address: pairAddress(p.opener, p.joiner), payer: keyOf(s.payer), windowStart: Number(s.windowStart.toString()) });
    });
    for (const group of groupsOf(pairsToClose(rows, ctx.now).slice(0, PER_PASS), PER_TX)) {
      const r = await act(ctx, "sweep", `pairs=${group.length}`, `close_pair x${group.length} (24 h window over)`, async () =>
        d.send(await Promise.all(group.map((g) => closePairIx(ctx.core, { caller: ctx.payer.publicKey, opener: g.opener, joiner: g.joiner, pair: g.address, payer: g.payer }))), {}),
      );
      actions += +r.ok;
    }
  }
  return actions;
}

// ---- Listing upkeep --------------------------------------------------------------------------------------------------

/** The slot an upgradeable program was last deployed in: bytes 4..12 of its ProgramData account. */
export const deploySlotOf = (programData: Uint8Array) => Buffer.from(programData.buffer, programData.byteOffset, programData.byteLength).readBigUInt64LE(4);

export interface ListedGame {
  game: PublicKey;
  record: PublicKey;
  listedUntil: number;
  approvedSlot: bigint;
}

export const listedGameOf = (record: PublicKey, g: any): ListedGame => ({ game: keyOf(g.game), record, listedUntil: Number(g.listedUntil.toString()), approvedSlot: BigInt(g.approvedSlot.toString()) });

export type ListingStep = { kind: "current" } | { kind: "refresh" };

/** A listed Game whose program was deployed again since it was approved needs `refresh_listing`; the program decides whether the code is the same. */
export const listingStep = (g: ListedGame, deployedSlot: bigint, now: number): ListingStep | null => (now >= g.listedUntil ? null : deployedSlot === g.approvedSlot ? { kind: "current" } : { kind: "refresh" });

/** What a dry run of `refresh_listing` says: the code really changed (a person must list it again), or a harmless race. */
export const listingOutcome = (why: string | null): "ok" | "changed" | "harmless" | "other" => {
  if (why === null) return "ok";
  if (/CodeChanged/.test(why)) return "changed";
  if (/ListingCurrent|NotListed/.test(why)) return "harmless";
  return "other";
};

/**
 * Job: listing upkeep (ticket 10). For each listed Game whose ProgramData slot moved since approval, sends `refresh_listing`
 * (it only succeeds while the bytes still hash to the approved hash, e.g. after a stranger's ExtendProgram). `CodeChanged`
 * means a real upgrade: not retried, and an alert goes to the admin until `list_game` is run with the new hash.
 */
export async function listingJob(ctx: Ctx, d: SweepDeps = realSweepDeps(ctx)): Promise<number> {
  const games = (await d.list("GameRecord")).map((r) => listedGameOf(r.pubkey, ctx.core.coder.accounts.decode("gameRecord", r.data)));
  const live = games.filter((g) => ctx.now < g.listedUntil);
  if (!live.length) return 0;
  const datas = await d.read.many(live.map((g) => programDataOf(g.game)));
  let actions = 0;
  for (let i = 0; i < live.length; i++) {
    const g = live[i];
    const info = datas[i];
    const key = `listing:${g.game.toBase58()}`;
    if (!info) continue;
    const step = listingStep(g, deploySlotOf(info.data), ctx.now);
    if (!step || step.kind === "current") {
      clearRaised(key);
      continue;
    }
    const subject = `game=${shortKey(g.game)}`;
    const ix = await refreshListingIx(ctx.core, { gameRecord: gameRecordOf(g.game), game: g.game });
    const outcome = listingOutcome(await d.simulate([ix]));
    if (outcome === "changed") {
      raise({ key, title: "A listed Game was upgraded", detail: `The program of the listed Game ${g.game.toBase58()} changed since it was approved: it stays unlisted until the admin runs list_game with the new code hash (keeper/scripts/register-game.ts --list).` });
      log("listing", subject, "ALERT the code changed: the Game is unlisted until list_game is run again");
      continue;
    }
    if (outcome !== "ok") {
      if (outcome === "other") log("listing", subject, "WARN refresh_listing would fail for another reason; will retry");
      continue;
    }
    clearRaised(key);
    actions += +(await act(ctx, "listing", subject, "refresh_listing (the program was extended, its code is the approved code)", () => d.send([ix], { units: 1_400_000 }))).ok;
  }
  return actions;
}

export type { Keypair };
