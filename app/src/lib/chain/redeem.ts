import "./polyfill";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { bookPda, ckptPda, CLASS_PLATFORM, CLASS_LEADERBOARD } from "./basket";
import { decodeBook, type SourceBookView } from "./book";
import { coreIx } from "./core-ix";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import type { ChainHolding } from "./read";
import { SponsorError, sponsoredSend } from "./sponsor-client";
import { TESORO_CORE_ID, accountPda, createSimSolAtaIx, redeemIx, simSolAta, sourcePda, unlockIx, type LineTarget, type PrevAdvance } from "./native";
import { createAtaIdempotentIx, tokenAta } from "./stake-pool";
import { JITOSOL, redeemStakeIx, stakeTokenOf, unlockStakeIx, type StakeToken } from "./stake";

/**
 * Redeem and Unlock on baskets: the right instruction for the kind of Position, with the Source's book and the checkpoint
 * pages a landing may write, sent through the relayer when it is free to the Player.
 */

type Reader = { getMultipleAccountsInfo(keys: PublicKey[]): Promise<({ data: Uint8Array } | null)[]> };

/** `init_ckpt_page`: the payer creates the next page of a class's checkpoint records (only the page being filled, or the next). */
export const initCkptPageIx = (payer: PublicKey, source: PublicKey, classId: number, pageNo: number) =>
  coreIx("init_ckpt_page", { payer, book: bookPda(source), page: ckptPda(source, classId, pageNo) }, { class: classId, page_no: pageNo });

/** Records one landing can close per class: normalise twice and rescale once. */
const CLOSES_PER_LANDING = 3;

/** Pages a landing into this book may write: for each class that still has unpaid Gemas, the page of its next record and the next. */
export function landingPageNumbers(book: SourceBookView): { classId: number; page: number }[] {
  const out: { classId: number; page: number }[] = [];
  book.classes.forEach((c, classId) => {
    if (classId === CLASS_PLATFORM || classId === CLASS_LEADERBOARD || c.uncovered === 0n) return;
    const first = Math.floor(c.ck / 32);
    const last = Math.floor((c.ck + CLOSES_PER_LANDING) / 32);
    for (let page = first; page <= last; page++) out.push({ classId, page });
  });
  return out;
}

export interface LandingPlan {
  /** Checkpoint pages that exist and are passed to the instruction. */
  accounts: PublicKey[];
  /** `init_ckpt_page` for pages a landing may need and nobody created yet; they go first in the same transaction. */
  create: TransactionInstruction[];
}

/** Which of the landing pages exist, and the instructions that create the rest. */
export async function landingPlan(conn: Reader, source: PublicKey, payer: PublicKey): Promise<LandingPlan> {
  const [bookInfo] = await conn.getMultipleAccountsInfo([bookPda(source)]);
  if (!bookInfo) return { accounts: [], create: [] };
  const wanted = landingPageNumbers(decodeBook(bookInfo.data));
  const keys = wanted.map((w) => ckptPda(source, w.classId, w.page));
  const infos = keys.length ? await conn.getMultipleAccountsInfo(keys) : [];
  const accounts: PublicKey[] = [];
  const create: TransactionInstruction[] = [];
  wanted.forEach((w, i) => {
    if (infos[i]) accounts.push(keys[i]);
    else {
      create.push(initCkptPageIx(payer, source, w.classId, w.page));
      accounts.push(keys[i]);
    }
  });
  return { accounts, create };
}

const unique = (keys: PublicKey[]) => [...new Map(keys.map((k) => [k.toBase58(), k])).values()];

/** The book and pages an instruction on `source` passes, with the landing pages added; `create` must run first. */
export async function sourceAccounts(conn: Reader, source: PublicKey, known: PublicKey[], payer: PublicKey): Promise<{ accounts: PublicKey[]; create: TransactionInstruction[] }> {
  const plan = await landingPlan(conn, source, payer);
  return { accounts: unique([bookPda(source), ...known, ...plan.accounts]), create: plan.create };
}

/** Sends `ixs` with the relayer paying the fee when the allow-list takes them (Core instructions only: a token account or a checkpoint page to create is the Player's own cost), else the Player pays. */
export async function exitSend(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], opts: { sponsor?: boolean } = {}): Promise<string> {
  const pageDisc = initCkptPageIx(signer.publicKey, signer.publicKey, 1, 0).data.subarray(0, 8);
  const free = ixs.every((ix) => ix.programId.equals(TESORO_CORE_ID) && !ix.data.subarray(0, 8).equals(pageDisc));
  if (free && opts.sponsor !== false) {
    try {
      return await sponsoredSend(signer, getToken, ixs);
    } catch (e) {
      if (!(e instanceof SponsorError) || !(e.selfPay || e.code === "unsupported-wallet")) throw e;
    }
  }
  return getChain().sendBase(signer, ixs);
}

const tokenOf = (mint: PublicKey | null | undefined): StakeToken | null => (mint ? (stakeTokenOf(mint) ?? JITOSOL) : null);

/** The instruction that creates the holder's simSOL or staking-token account, or nothing when it exists (then the exit can be free). */
async function ataIx(conn: Reader, me: PublicKey, token: StakeToken | null): Promise<TransactionInstruction[]> {
  const ata = token ? tokenAta(me, token.mint) : simSolAta(me);
  const [info] = await conn.getMultipleAccountsInfo([ata]);
  if (info) return [];
  return [token ? createAtaIdempotentIx(me, me, token.mint) : createSimSolAtaIx(me, me)];
}

/** The instructions that Redeem `gemas` of one line of a Solana Source, with the token account created if missing. */
export async function redeemLineIxs(conn: Reader, me: PublicKey, h: Pick<ChainHolding, "line" | "accounts" | "source" | "position" | "stakeMint">, gemas: bigint): Promise<TransactionInstruction[]> {
  const { accounts, create } = await sourceAccounts(conn, h.source, h.accounts, me);
  const target: LineTarget = { line: h.line, accounts };
  const token = tokenOf(h.stakeMint);
  const ata = await ataIx(conn, me, token);
  return [
    ...create,
    ...ata,
    token ? redeemStakeIx(me, h.position, h.source, gemas, target, token) : redeemIx(me, h.position, h.source, gemas, target),
  ];
}

/** Redeem `gemas` of one line (a native or staking-token Source), through the relayer when the token account exists. */
export async function redeemLine(signer: ChainSigner, getToken: GetToken, h: Parameters<typeof redeemLineIxs>[2], gemas: bigint): Promise<string> {
  const ixs = await redeemLineIxs(getChain().base, signer.publicKey, h, gemas);
  return exitSend(signer, getToken, ixs);
}

/** The Position's open Advance as `unlock` and a new Advance need it: its index, the Source's book and the pages. Null when none is open. */
export async function prevAdvanceOf(conn: Reader, position: PublicKey, openAdvance: number | null, payer: PublicKey): Promise<{ prev: PrevAdvance | null; create: TransactionInstruction[] }> {
  if (openAdvance === null) return { prev: null, create: [] };
  const { accounts, create } = await sourceAccounts(conn, sourcePda(position, openAdvance), [], payer);
  return { prev: { index: openAdvance, accounts }, create };
}

/** Unlock a Solana Position (simSOL or staking token): Debt must be zero; closes the open Advance and returns the Principal with the free yield. */
export async function unlockPosition(signer: ChainSigner, getToken: GetToken, info: { position: PublicKey; openAdvance: number | null; stakeRateOpen: bigint; mint: PublicKey }): Promise<string> {
  const me = signer.publicKey;
  const { prev, create } = await prevAdvanceOf(getChain().base, info.position, info.openAdvance, me);
  const token = info.stakeRateOpen > 0n ? tokenOf(info.mint) : null;
  return exitSend(signer, getToken, [
    ...create,
    ...(await ataIx(getChain().base, me, token)),
    token ? unlockStakeIx(me, info.position, prev, token) : unlockIx(me, info.position, prev),
  ]);
}

export { accountPda };
