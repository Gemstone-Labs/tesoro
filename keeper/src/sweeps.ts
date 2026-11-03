import { PublicKey, type Keypair } from "@solana/web3.js";
import { clearRaised, raise } from "./alerts.ts";
import { act, log, type Ctx } from "./act.ts";
import { refreshListingIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { gameRecordOf, keyOf, programDataOf } from "./kit.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { connReader, type Reader } from "./supply.ts";
import { closeOldPairs, closeOldReceipts } from "./reclaim.ts";
import { simulate } from "./tee.ts";

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

/** Job: closes receipts older than 14 days and pair counters whose 24 h window ended, so their rent comes back. */
export async function sweepJob(ctx: Ctx, d: SweepDeps = realSweepDeps(ctx)): Promise<number> {
  return (await closeOldReceipts(ctx, d, "sweep", PER_PASS)).actions + (await closeOldPairs(ctx, d, "sweep", PER_PASS)).actions;
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
