import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { decodeBook } from "@/lib/chain/book";
import { CKPT_PAGE_AT, CKPT_PAGE_HEADER, CKPT_PER_PAGE, CKPT_RECORD_LEN } from "@/lib/chain/basket";
import { sourcePda } from "@/lib/chain/native";
import { landingPageNumbers } from "@/lib/chain/redeem";
import { DemoHttpError } from "../request-auth";
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
  const position = await chain.account(s.position), source = await chain.account(s.source);
  if (!position?.owner.equals(CORE_ID) || !source?.owner.equals(CORE_ID)) bad("The payout's Lock and Source must exist.");
  let p: any, sourceState: any;
  try { p = coder.decode("PositionState", Buffer.from(position!.data)); sourceState = coder.decode("SourceState", Buffer.from(source!.data)); }
  catch { bad("The payout's Lock or Source could not be read."); }
  if (!sourcePda(s.position, sourceState.inner.index).equals(s.source) || !new PublicKey(sourceState.inner.position).equals(s.position)) bad("The Source does not belong to the payout's Lock.");
  if (!("Solana" in p.inner.source_chain)) bad("These token accounts are only for Solana payouts.");
  const mint = new PublicKey(p.inner.source_asset);
  let rent = 0n;
  let ataGrant: string | null = null;
  if (s.ata) {
    if (!s.ata.mint.equals(mint)) bad("The token account's mint is not the payout asset.");
    if (await chain.account(s.ata.address)) bad("The payout token account already exists; no setup is needed.");
    rent += await chain.rent(165);
    ataGrant = exitAtaKey(player, mint);
  }
  if (s.pages.length) {
    const book = await chain.account(s.pages[0].book);
    if (!book?.owner.equals(CORE_ID) || !Buffer.from(book.data.subarray(0, 8)).equals(bookDisc) || book.data[9] !== 1 || !Buffer.from(book.data.subarray(16, 48)).equals(s.source.toBuffer())) bad("The payout Source's book is invalid.");
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
