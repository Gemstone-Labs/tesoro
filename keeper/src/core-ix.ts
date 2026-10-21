import anchor from "@coral-xyz/anchor";
import type { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { gameRecordOf, pda, programDataOf } from "./kit.ts";

/** The tesoro_core program client (`ctx.core`), which the app and the keeper type differently (two installs of anchor). */
export type Core = { methods: any; coder: any; account: any; programId: any };

export const meta = (pubkey: PublicKey, writable = true): AccountMeta => ({ pubkey, isSigner: false, isWritable: writable });

const BN = anchor.BN;
export type StoreKind = "basket" | "spill";
const storeKind = (k: StoreKind) => (k === "basket" ? { basket: {} } : { spill: {} });

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

/** Starts a refund of an Open or Active Match: the Game's authority at any time, anyone once its deadline passed or its Game was upgraded. */
export const refundMatchIx = (core: Core, o: { caller: PublicKey; payer: PublicKey; game: PublicKey; matchState: PublicKey; openerProtections?: PublicKey | null }): Promise<TransactionInstruction> =>
  core.methods
    .refundMatch()
    .accountsPartial({ caller: o.caller, payer: o.payer, gameRecord: gameRecordOf(o.game), gameProgram: o.game, programData: programDataOf(o.game), matchState: o.matchState, openerProtections: o.openerProtections ?? null })
    .instruction();

export const growStoreIx = (core: Core, o: { payer: PublicKey; account: PublicKey; which: StoreKind; extra: number }): Promise<TransactionInstruction> =>
  core.methods.growStore(storeKind(o.which), o.extra).accountsPartial({ payer: o.payer, account: o.account }).instruction();

export const claimSpillIx = (core: Core, o: { account: PublicKey; max: number; remaining?: AccountMeta[] }): Promise<TransactionInstruction> =>
  core.methods.claimSpill(o.max).accountsPartial({ account: o.account }).remainingAccounts(o.remaining ?? []).instruction();

/** Cancels an Entry or Backing Ticket (the owner at any time, anyone once it expired) and returns up to `maxLines` staged lines. */
export const cancelTicketIx = (core: Core, o: { signer: PublicKey; owner: PublicKey; ticket: PublicKey; offer?: PublicKey | null; maxLines: number; remaining?: AccountMeta[] }): Promise<TransactionInstruction> =>
  core.methods
    .cancelTicket(o.maxLines)
    .accountsPartial({ signer: o.signer, owner: o.owner, ticket: o.ticket, offer: o.offer ?? null })
    .remainingAccounts(o.remaining ?? [])
    .instruction();

export const closeTicketIx = (core: Core, o: { caller: PublicKey; ticket: PublicKey; payer: PublicKey; sponsor?: PublicKey | null }): Promise<TransactionInstruction> =>
  core.methods.closeTicket().accountsPartial({ caller: o.caller, ticket: o.ticket, payer: o.payer, sponsor: o.sponsor ?? null }).instruction();

export const closeReceiptIx = (core: Core, o: { caller: PublicKey; receipt: PublicKey; payer: PublicKey }): Promise<TransactionInstruction> =>
  core.methods.closeReceipt().accountsPartial({ caller: o.caller, receipt: o.receipt, payer: o.payer }).instruction();

export const closePairIx = (core: Core, o: { caller: PublicKey; opener: PublicKey; joiner: PublicKey; pair: PublicKey; payer: PublicKey }): Promise<TransactionInstruction> =>
  core.methods.closePair(o.opener, o.joiner).accountsPartial({ caller: o.caller, pair: o.pair, payer: o.payer }).instruction();

export const refreshListingIx = (core: Core, o: { gameRecord: PublicKey; game: PublicKey }): Promise<TransactionInstruction> =>
  core.methods.refreshListing().accountsPartial({ gameRecord: o.gameRecord, gameProgram: o.game, programData: programDataOf(o.game) }).instruction();

export const initCkptPageIx = (core: Core, o: { payer: PublicKey; book: PublicKey; page: PublicKey; cls: number; pageNo: number }): Promise<TransactionInstruction> =>
  core.methods.initCkptPage(o.cls, o.pageNo).accountsPartial({ payer: o.payer, book: o.book, page: o.page }).instruction();

/** Gives an expired Instant Redeem order's Gemas back to the seller. */
export const expireInstantRedeemIx = (core: Core, o: { signer: PublicKey; ownerAccount: PublicKey; order: PublicKey; ownerWallet: PublicKey; sponsor?: PublicKey | null }): Promise<TransactionInstruction> =>
  core.methods
    .expireInstantRedeem()
    .accountsPartial({ signer: o.signer, ownerAccount: o.ownerAccount, order: o.order, ownerWallet: o.ownerWallet, sponsor: o.sponsor ?? null })
    .instruction();

export const fillInstantRedeemIx = (
  core: Core,
  o: { filler: PublicKey; order: PublicKey; ownerWallet: PublicKey; position: PublicKey; source: PublicKey; gemas: bigint; remaining: AccountMeta[]; sponsor?: PublicKey | null },
): Promise<TransactionInstruction> =>
  core.methods
    .fillInstantRedeem(new BN(o.gemas.toString()))
    .accountsPartial({ filler: o.filler, order: o.order, ownerWallet: o.ownerWallet, position: o.position, source: o.source, sponsor: o.sponsor ?? null })
    .remainingAccounts(o.remaining)
    .instruction();

/** Moves the ready part of a Source's Leaderboard counter into the prize escrow. Remaining: the kind's accounts, then the book and pages. */
export const harvestIx = (core: Core, o: { position: PublicKey; source: PublicKey; remaining: AccountMeta[] }): Promise<TransactionInstruction> =>
  core.methods.harvest().accountsPartial({ position: o.position, source: o.source }).remainingAccounts(o.remaining).instruction();

export const cashInFeeIx = (core: Core, o: { cls: number; recipientAccount: PublicKey; position: PublicKey; source: PublicKey; remaining: AccountMeta[] }): Promise<TransactionInstruction> =>
  core.methods.cashInFee(o.cls).accountsPartial({ recipientAccount: o.recipientAccount, position: o.position, source: o.source }).remainingAccounts(o.remaining).instruction();

export const expireOfferIx = (core: Core, o: { caller: PublicKey; backerAccount: PublicKey; offer: PublicKey; request?: PublicKey | null; backerProtections?: PublicKey | null }): Promise<TransactionInstruction> =>
  core.methods
    .expireOffer()
    .accountsPartial({ caller: o.caller, backerAccount: o.backerAccount, offer: o.offer, request: o.request ?? null, backerProtections: o.backerProtections ?? null })
    .instruction();

export const clearRequestIx = (core: Core, o: { caller: PublicKey; request: PublicKey; protections: PublicKey }): Promise<TransactionInstruction> =>
  core.methods.clearRequest().accountsPartial({ caller: o.caller, request: o.request, protections: o.protections }).instruction();

// ---- Seasons ----------------------------------------------------------------------------------------------------

export const recordSeasonIx = (
  core: Core,
  o: { authority: PublicKey; number: number; points: bigint[]; poolAccount: PublicKey; ranked: PublicKey[]; routes: PublicKey[] },
): Promise<TransactionInstruction> =>
  core.methods
    .recordSeason(o.number, o.points.map((p) => new BN(p.toString())))
    .accountsPartial({ authority: o.authority, poolAccount: o.poolAccount })
    .remainingAccounts([...o.ranked, ...o.routes].map((k) => meta(k, false)))
    .instruction();

export const paySeasonRankIx = (
  core: Core,
  o: { authority: PublicKey; season: PublicKey; poolAccount: PublicKey; winnerAccount: PublicKey; prizeSource: PublicKey; rank: number; line: number },
): Promise<TransactionInstruction> =>
  core.methods
    .paySeasonRank(o.rank, o.line)
    .accountsPartial({ authority: o.authority, season: o.season, poolAccount: o.poolAccount, winnerAccount: o.winnerAccount, prizeSource: o.prizeSource })
    .instruction();

export const closeSeasonIx = (core: Core, o: { season: PublicKey }): Promise<TransactionInstruction> => core.methods.closeSeason().accountsPartial({ season: o.season }).instruction();

export const fundSeasonPrizeNativeIx = (
  core: Core,
  o: { authority: PublicKey; season: number; custody: PublicKey; pool: PublicKey; priceFeed: PublicKey; poolAccount: PublicKey; prizeSource: PublicKey },
): Promise<TransactionInstruction> =>
  core.methods
    .fundSeasonPrizeNative(o.season)
    .accountsPartial({ authority: o.authority, custody: o.custody, pool: o.pool, priceFeed: o.priceFeed, poolAccount: o.poolAccount, prizeSource: o.prizeSource })
    .instruction();

export const fundSeasonPrizeStakeIx = (
  core: Core,
  o: { authority: PublicKey; season: number; custody: PublicKey; mint: PublicKey; stakePool: PublicKey; priceFeed: PublicKey; poolAccount: PublicKey; prizeSource: PublicKey },
): Promise<TransactionInstruction> =>
  core.methods
    .fundSeasonPrizeStake(o.season)
    .accountsPartial({
      authority: o.authority,
      custody: o.custody,
      mint: o.mint,
      stakePool: o.stakePool,
      onchainPrice: pda("onchain_price", o.mint.toBuffer()),
      priceFeed: o.priceFeed,
      poolAccount: o.poolAccount,
      prizeSource: o.prizeSource,
    })
    .instruction();
