import "./polyfill";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { withdrawOwnOpenItems } from "./backing";
import { accountReady, createAccountIx } from "./match-flow";
import { advanceSetup } from "./advance-setup";
import { exitSend, prevAdvanceOf, redeemLine, sourceAccounts, unlockPosition } from "./redeem";
import type { ChainHolding } from "./read";
import { sourcePda } from "./native";
import { ensureSol as ensureDevnetSol, type GetToken } from "./demo-client";
import { CLUSTER } from "../cluster-settings";
import { DEPOSIT_SLIPPAGE_BPS, createAtaIdempotentIx, depositSolIx, parseStakePool, quoteDepositSol, tokenAta } from "./stake-pool";
import {
  JITOSOL,
  extendStakeAdvanceIx,
  openStakePositionIx,
  stakePositionPda,
  stakeTokenOf,
  takeStakeAdvanceIx,
  type StakeToken,
} from "./stake";
import {
  extendNativeAdvanceIx,
  faucetIx,
  openNativePositionIx,
  positionPda,
  setBreakIx,
  setEntryLimitIx,
  setSelfExclusionIx,
  setExtendLimitIx,
  takeNativeAdvanceIx,
  type NativeInfo,
} from "./native";
import { extendFailure, plainError } from "@/lib/errors";

/** On mainnet the Player pays their own fees: there is no faucet to top the wallet up. */
const ensureSol: typeof ensureDevnetSol = (...args) => (CLUSTER.yieldModel === "real" ? Promise.resolve() : ensureDevnetSol(...args));

/** The staking token a Position or Source holds; throws for a token this app version cannot read. */
function tokenFor(mint: PublicKey | null | undefined): StakeToken | null {
  if (!mint) return null;
  const token = stakeTokenOf(mint);
  if (!token) throw new Error("This Lock holds a staking token this version of the app does not support yet.");
  return token;
}

/** The one line a Player sees for a failed Wallet action (see lib/errors.ts). */
export const friendlyError = plainError;

const send = (signer: ChainSigner, ixs: TransactionInstruction[]) => getChain().sendBase(signer, ixs);

/**
 * SIMULATED faucet: 10 simSOL per hour. Tops up SOL for fees first when the wallet is nearly empty, and
 * creates the Account in the same transaction when there is none, so a new wallet signs once.
 */
export async function getTestSimSol(signer: ChainSigner, getToken: GetToken, onStep: (s: string) => void = () => undefined): Promise<string> {
  const existing = !!(await getChain().base.getAccountInfo(BlockPuzzleChain.coreAccount(signer.publicKey)));
  const account = await accountReady(signer, getToken, existing);
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  onStep("Getting test SOL");
  const faucet = faucetIx(signer.publicKey);
  return send(signer, account ? [faucet] : [await createAccountIx(signer.publicKey), faucet]);
}

/**
 * One transaction: `open_native_position` (deposits simSOL) + `take_native_advance` (the Horizon), with
 * `create_account` in front when the wallet has no Account yet. Reads only the Account and the SOL balance.
 */
export async function openPositionWithAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  simSolBaseUnits: bigint,
  months: number,
  minGemas: bigint,
  onStep: (s: string) => void = () => undefined,
): Promise<{ signature: string; position: string }> {
  onStep("Preparing");
  const existing = !!(await getChain().base.getAccountInfo(BlockPuzzleChain.coreAccount(signer.publicKey)));
  const account = await accountReady(signer, getToken, existing);
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  const nonce = BigInt(Date.now());
  const position = await positionPda(signer.publicKey, nonce);
  const setup = account ? await advanceSetup(getChain().base, signer.publicKey, BlockPuzzleChain.coreAccount(signer.publicKey)) : [await createAccountIx(signer.publicKey)];
  const ixs = [openNativePositionIx(signer.publicKey, nonce, simSolBaseUnits, position), takeNativeAdvanceIx(signer.publicKey, position, 0, months, minGemas)];
  onStep("Locking your SOL");
  const signature = await send(signer, [...setup, ...ixs]);
  return { signature, position: position.toBase58() };
}

/**
 * Another Advance on a locked Position whose Debt is zero at the clock: `take_native_advance` as Advance number
 * `info.advances`, closing the open one in the same instruction (its Source is passed as `prev_source`). No crank.
 */
export async function takeNextAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  info: NativeInfo,
  months: number,
  minGemas: bigint,
  onStep: (s: string) => void = () => undefined,
): Promise<string> {
  onStep("Preparing");
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  onStep("Taking the Advance");
  const token = info.stakeRateOpen > 0n ? tokenFor(info.mint) : null;
  const { prev, create } = await prevAdvanceOf(getChain().base, info.position, info.openAdvance, signer.publicKey);
  return send(signer, [
    ...await advanceSetup(getChain().base, signer.publicKey, BlockPuzzleChain.coreAccount(signer.publicKey)),
    ...create,
    token
      ? takeStakeAdvanceIx(signer.publicKey, info.position, info.advances, months, minGemas, prev, token)
      : takeNativeAdvanceIx(signer.publicKey, info.position, info.advances, months, minGemas, prev),
  ]);
}

/** Extend the open Advance of a locked SOL Position with `extend_native_advance`. The Gemas land in the owner's Holding of the same Source. */
export async function extendAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  info: NativeInfo,
  extraMonths: number,
  minGemas: bigint,
  onStep: (s: string) => void = () => undefined,
): Promise<string> {
  if (!info.source) throw new Error("This Lock has no open Advance.");
  onStep("Preparing");
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  onStep("Extending the Advance");
  try {
    const token = info.stakeRateOpen > 0n ? tokenFor(info.mint) : null;
    const { accounts, create } = await sourceAccounts(getChain().base, sourcePda(info.position, info.source.index), [], signer.publicKey);
    return await send(signer, [
      ...await advanceSetup(getChain().base, signer.publicKey, BlockPuzzleChain.coreAccount(signer.publicKey)),
      ...create,
      token
        ? extendStakeAdvanceIx(signer.publicKey, info.position, info.source.index, extraMonths, minGemas, accounts, token)
        : extendNativeAdvanceIx(signer.publicKey, info.position, info.source.index, extraMonths, minGemas, accounts),
    ]);
  } catch (e) {
    throw extendFailure(e);
  }
}

/** Sets the owner's Extend Limit (0 to 11 months): lower applies at once, higher 24 hours later. */
export async function setExtendLimit(signer: ChainSigner, getToken: GetToken, months: number): Promise<string> {
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  return send(signer, [setExtendLimitIx(signer.publicKey, months)]);
}

/** Sets the owner's Entry Limit in Gemas (0 = none): lower applies at once, higher (or none) 24 hours later. */
export async function setEntryLimit(signer: ChainSigner, getToken: GetToken, gemas: number): Promise<string> {
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  return send(signer, [setEntryLimitIx(signer.publicKey, gemas)]);
}

/**
 * Starts a Break (1 to 42 days) or lengthens the one running. Then withdraws the Account's unpaired Matches, Requests and Offers (set first, so nobody can join in between);
 * if that part fails the keeper finishes it. Matches already paired play out. It cannot be ended or shortened.
 */
export async function startBreak(signer: ChainSigner, getToken: GetToken, days: number): Promise<string> {
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  const sig = await send(signer, [setBreakIx(signer.publicKey, days)]);
  await withdrawOwnOpenItems(signer);
  return sig;
}

/** Starts a Self-Exclusion (6 to 60 months) or lengthens the one running; then clears out unpaired items, like `startBreak`. */
export async function startSelfExclusion(signer: ChainSigner, getToken: GetToken, months: number): Promise<string> {
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  const sig = await send(signer, [setSelfExclusionIx(signer.publicKey, months)]);
  await withdrawOwnOpenItems(signer);
  return sig;
}

/**
 * Redeem Gemas of one line of a native or staking-token Source into simSOL (or the token on mainnet). The relayer pays the fee
 * when the Player's token account exists; the account is created (at the Player's cost) when it does not.
 */
export const redeemNative = (signer: ChainSigner, getToken: GetToken, h: Parameters<typeof redeemLine>[2], gemas: bigint) => redeemLine(signer, getToken, h, gemas);

/** Unlock: the program computes Debt itself, closes the open Advance and returns the Principal with the free yield (in the staking token on mainnet). */
export const unlockNative = (signer: ChainSigner, getToken: GetToken, info: NativeInfo) => unlockPosition(signer, getToken, info);

export type { ChainHolding };
export { exitSend };

// ---- Mainnet: open with the staking token or plain SOL -----------------------------------------------

export type StakeDeposit = { from: "token"; shares: bigint } | { from: "sol"; lamports: bigint };

/**
 * Opens a Position on the active staking token and takes the Advance. With the token itself that is one transaction. With plain SOL the
 * first transaction is the pool's DepositSol followed by the open for the tokens the quote promises less 0.5%: when the deposit
 * mints fewer, the whole transaction reverts and nothing moved. The Advance is a second transaction (the first is already full).
 */
export async function openStakePositionWithAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  deposit: StakeDeposit,
  months: number,
  minGemas: bigint,
  token: StakeToken = JITOSOL,
  onStep: (s: string) => void = () => undefined,
): Promise<{ signature: string; position: string }> {
  onStep("Preparing");
  const me = signer.publicKey;
  const base = getChain().base;
  const [existing, poolInfo] = await Promise.all([base.getAccountInfo(BlockPuzzleChain.coreAccount(me)), deposit.from === "sol" ? base.getAccountInfo(token.pool) : null]);
  const account = await accountReady(signer, getToken, !!existing);
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  const nonce = BigInt(Date.now());
  const position = await stakePositionPda(me, nonce);
  const advance = takeStakeAdvanceIx(me, position, 0, months, minGemas, null, token);
  const prefix = account ? await advanceSetup(base, me, BlockPuzzleChain.coreAccount(me)) : [await createAccountIx(me)];
  if (deposit.from === "token") {
    onStep("Locking your SOL");
    const signature = await send(signer, [...prefix, openStakePositionIx(me, nonce, deposit.shares, position, token), advance]);
    return { signature, position: position.toBase58() };
  }
  const view = poolInfo && poolInfo.owner.equals(token.poolProgram) ? parseStakePool(poolInfo.data) : null;
  if (!view) throw new Error("The staking pool could not be read. Try again in a moment.");
  const quote = quoteDepositSol(deposit.lamports, view, DEPOSIT_SLIPPAGE_BPS);
  if (quote.problem) throw new Error(quote.problem);
  onStep("Staking and locking your SOL");
  const signature = await send(signer, [
    ...prefix,
    createAtaIdempotentIx(me, me, token.mint),
    depositSolIx({ pool: token.pool, view, from: me, dest: stakeTokenAccount(me, token), lamports: deposit.lamports, program: token.poolProgram }),
    openStakePositionIx(me, nonce, quote.openTokens, position, token),
  ]);
  onStep("Taking the Advance");
  try {
    await send(signer, [advance]);
  } catch (e) {
    throw new Error(`Your Lock is open, but the Advance did not go through: ${friendlyError(e)} Take it from the Lock card.`);
  }
  return { signature, position: position.toBase58() };
}

const stakeTokenAccount = (owner: PublicKey, token: StakeToken) => tokenAta(owner, token.mint);
