import "./polyfill";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { bookPda, ckptPda, CLASS_PLATFORM, CLASS_LEADERBOARD } from "./basket";
import { decodeBook, type SourceBookView } from "./book";
import { initCkptPageIx } from "./settle-plan";
import { planExit } from "./exit-route";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import type { ChainHolding } from "./read";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";
import coreIdl from "./idl/tesoro_core.json";
import { SIM_SOL_MINT, TESORO_CORE_ID, accountPda, redeemIx, simSolAta, sourcePda, unlockIx, type LineTarget, type PrevAdvance } from "./native";
import { createAtaIdempotentIx, tokenAta } from "./stake-pool";
import { stakePoolRefreshIxs } from "./stake-pool-refresh";
import { redeemStakeIx, stakeTokenOf, unlockStakeIx, type StakeToken } from "./stake";

/**
 * Redeem and Unlock on baskets: the right instruction for the kind of Position, with the Source's book and the checkpoint
 * pages a landing may write, sent through the relayer when it is free to the Player.
 */

type Reader = { getMultipleAccountsInfo(keys: PublicKey[]): Promise<({ data: Uint8Array } | null)[]> };

export { initCkptPageIx };

const INIT_CKPT_PAGE_DISC = Buffer.from((coreIdl.instructions.find((i) => i.name === "init_ckpt_page") as { discriminator: number[] }).discriminator);
/** Whether an instruction is tesoro_core's `init_ckpt_page`. */
export const isInitCkptPage = (ix: TransactionInstruction) => ix.programId.equals(TESORO_CORE_ID) && Buffer.from(ix.data.subarray(0, 8)).equals(INIT_CKPT_PAGE_DISC);

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

/** Sends one of the Player's exits as `planExit` says: free or with setup paid by the relayer when the sponsor accepts it, else self-pay. */
export async function exitSend(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], opts: { sponsor?: boolean; selfPayIxs?: TransactionInstruction[] } = {}): Promise<string> {
  if (opts.sponsor !== false) {
    try {
      const route = planExit(ixs, signer.publicKey, new PublicKey((await sponsorStatus()).relayer));
      if (route.kind !== "self-pay") return await sponsoredSend(signer, getToken, route.ixs);
    } catch (e) {
      if (!(e instanceof SponsorError) || !(e.selfPay || e.code === "unsupported-wallet")) throw e;
    }
  }
  return getChain().sendBase(signer, opts.selfPayIxs ?? ixs);
}

const tokenOf = (mint: PublicKey | null | undefined): StakeToken | null => {
  if (!mint) return null;
  const token = stakeTokenOf(mint);
  if (!token) throw new Error("This Lock's staking token is not supported by this version of the app.");
  return token;
};

/** The stake pool update in front of a staking-token payout, when the pool is too far behind. The sponsor admits it (rules.ts), so the exit stays free. */
const poolRefreshFor = (token: StakeToken | null): Promise<TransactionInstruction[]> => (token ? stakePoolRefreshIxs(getChain().base, token.pool) : Promise.resolve([]));

/** The instruction that creates the holder's simSOL or staking-token account, or nothing when it exists (then the exit can be free). */
async function ataIx(conn: Reader, me: PublicKey, token: StakeToken | null): Promise<TransactionInstruction[]> {
  const ata = token ? tokenAta(me, token.mint) : simSolAta(me);
  const [info] = await conn.getMultipleAccountsInfo([ata]);
  if (info) return [];
  return [createAtaIdempotentIx(me, me, token?.mint ?? SIM_SOL_MINT)];
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
  const refresh = await poolRefreshFor(tokenOf(h.stakeMint));
  const ixs = await redeemLineIxs(getChain().base, signer.publicKey, h, gemas);
  return exitSend(signer, getToken, [...refresh, ...ixs]);
}

/** The Position's open Advance as `unlock` and a new Advance need it: its index, the Source's book and the pages. Null when none is open. */
export async function prevAdvanceOf(conn: Reader, position: PublicKey, openAdvance: number | null, payer: PublicKey): Promise<{ prev: PrevAdvance | null; create: TransactionInstruction[] }> {
  if (openAdvance === null) return { prev: null, create: [] };
  const { accounts, create } = await sourceAccounts(conn, sourcePda(position, openAdvance), [], payer);
  return { prev: { index: openAdvance, accounts }, create };
}

type UnlockInfo = { position: PublicKey; openAdvance: number | null; stakeRateOpen: bigint; mint: PublicKey };

/** The instructions that Unlock a Solana Position (simSOL or staking token): the open Advance closes with it, the token account is created if missing. */
export async function unlockIxs(me: PublicKey, info: UnlockInfo): Promise<TransactionInstruction[]> {
  const { prev, create } = await prevAdvanceOf(getChain().base, info.position, info.openAdvance, me);
  const token = info.stakeRateOpen > 0n ? tokenOf(info.mint) : null;
  return [
    ...(await poolRefreshFor(token)),
    ...create,
    ...(await ataIx(getChain().base, me, token)),
    token ? unlockStakeIx(me, info.position, prev, token) : unlockIx(me, info.position, prev),
  ];
}

/** Unlock a Solana Position (simSOL or staking token): Debt must be zero; closes the open Advance and returns the Principal with the free yield. */
export async function unlockPosition(signer: ChainSigner, getToken: GetToken, info: UnlockInfo): Promise<string> {
  return exitSend(signer, getToken, await unlockIxs(signer.publicKey, info));
}

export { accountPda };
