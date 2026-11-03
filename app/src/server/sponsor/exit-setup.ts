import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { decodeBook } from "@/lib/chain/book";
import { CKPT_PAGE_AT, CKPT_PAGE_HEADER, CKPT_PER_PAGE, CKPT_RECORD_LEN } from "@/lib/chain/basket";
import { sourcePda } from "@/lib/chain/native";
import { positionBytes } from "@/lib/chain/position-size";
import { landingPageNumbers } from "@/lib/chain/redeem";
import { DemoHttpError } from "../request-auth";
import { isStale, parseStakePool, updateStakePoolBalanceIx } from "@/lib/chain/stake-pool";
import { STAKE_TOKENS } from "@/lib/chain/stake";
import { CORE_ID, type Plan } from "./rules";
import type { ChainReads } from "./service";

const coder = new BorshAccountsCoder(coreIdl as Idl);
const bookDisc = Buffer.from(coreIdl.accounts.find((a) => a.name === "SourceBookHead")!.discriminator);
export const EXIT_ATA_WINDOW_MS = 100 * 365 * 24 * 60 * 60 * 1000;
export const exitAtaKey = (player: PublicKey, mint: PublicKey) => `exit-ata:${player.toBase58()}:${mint.toBase58()}`;
const bad = (message: string): never => { throw new DemoHttpError(400, "bad-setup", message); };

/** Rent is read live. Setup must be required by this Source, not an arbitrary successful exit's extra accounts. */
export async function verifyExitSetup(plan: Plan, player: PublicKey, chain: ChainReads): Promise<{ rent: bigint; ataGrant: string | null }> {
  const s = plan.setup;
  if (!s) return { rent: 0n, ataGrant: null };
  if (!chain.rent) throw new DemoHttpError(503, "not-configured", "Payout account funding is not configured.");
  const position = await chain.account(s.position), source = s.source ? await chain.account(s.source) : null;
  if (!position?.owner.equals(CORE_ID) || (s.source && !source?.owner.equals(CORE_ID))) bad("The payout's Lock and Source must exist.");
  let p: any, sourceState: any;
  try { p = coder.decode("PositionState", positionBytes(position!.data)); sourceState = source ? coder.decode("SourceState", Buffer.from(source.data)) : null; }
  catch { bad("The payout's Lock or Source could not be read."); }
  if (s.source && (!sourcePda(s.position, sourceState.inner.index).equals(s.source) || !new PublicKey(sourceState.inner.position).equals(s.position))) bad("The Source does not belong to the payout's Lock.");
  // An Unlock closes the open Advance: its checkpoint pages are only ever for that Source.
  if (plan.names.at(-1) === "unlock" && s.source && p.inner.open_advance !== sourceState.inner.index) bad("The Source is not the Lock's open Advance.");
  if (!("Solana" in p.inner.source_chain)) bad("These token accounts are only for Solana payouts.");
  const mint = new PublicKey(p.inner.source_asset);
  if (s.poolUpdate) await verifyPoolUpdate(s.poolUpdate, s.poolUpdateIx!, mint, chain);
  let rent = 0n;
  let ataGrant: string | null = null;
  if (s.ata) {
    if (!s.ata.mint.equals(mint)) bad("The token account's mint is not the payout asset.");
    if (await chain.account(s.ata.address)) bad("The payout token account already exists; no setup is needed.");
    rent += await chain.rent(165);
    ataGrant = exitAtaKey(player, mint);
  }
  if (s.pages.length) {
    if (!s.source) bad("The checkpoint's Source is unknown.");
    const book = await chain.account(s.pages[0].book);
    if (!book?.owner.equals(CORE_ID) || !Buffer.from(book.data.subarray(0, 8)).equals(bookDisc) || book.data[9] !== 1 || !Buffer.from(book.data.subarray(16, 48)).equals(s.source!.toBuffer())) bad("The payout Source's book is invalid.");
    let needed: Set<string>;
    try { needed = new Set(landingPageNumbers(decodeBook(book!.data)).map((p) => `${p.classId}:${p.page}`)); }
    catch { return bad("The payout Source's book could not be read."); }
    for (const page of s.pages) {
      if (!needed.has(`${page.classId}:${page.pageNo}`) || await chain.account(page.page)) bad("The checkpoint is not missing or is not needed by this payout.");
      rent += await chain.rent(CKPT_PAGE_AT + CKPT_PAGE_HEADER + CKPT_PER_PAGE * CKPT_RECORD_LEN);
    }
  }
  return { rent, ataGrant };
}

/**
 * The stake pool update in front of a payout is paid for only when it does something: the Position's token is the one of this
 * pool, the pool is more than one epoch behind, and the instruction is exactly the one the pool's own accounts give.
 */
async function verifyPoolUpdate(pool: PublicKey, ix: NonNullable<Plan["setup"]>["poolUpdateIx"] & object, mint: PublicKey, chain: ChainReads): Promise<void> {
  if (!chain.epoch) throw new DemoHttpError(503, "not-configured", "Stake pool updates are not configured.");
  if (!STAKE_TOKENS.some((t) => t.pool.equals(pool) && t.mint.equals(mint))) bad("The stake pool is not the one of this Lock's staking token.");
  const [info, epoch] = await Promise.all([chain.account(pool), chain.epoch()]);
  const view = info ? parseStakePool(info.data) : null;
  if (!info || !view) return bad("The stake pool could not be read.");
  if (!isStale(view, epoch)) bad("The stake pool is current; its payout needs no update.");
  const want = updateStakePoolBalanceIx(pool, info);
  const same = want.programId.equals(ix.programId) && Buffer.from(want.data).equals(Buffer.from(ix.data)) && want.keys.length === ix.keys.length && want.keys.every((k, i) => k.pubkey.equals(ix.keys[i].pubkey) && k.isWritable === ix.keys[i].isWritable && k.isSigner === ix.keys[i].isSigner);
  if (!same) bad("The stake pool update does not name the pool's own accounts.");
}
