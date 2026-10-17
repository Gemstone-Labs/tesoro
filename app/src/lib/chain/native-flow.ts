import "./polyfill";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { withdrawOwnOpenItems } from "./backing";
import { createAccountIx } from "./match-flow";
import { ensureSol as ensureDevnetSol, type GetToken } from "./demo-client";
import { CLUSTER } from "../cluster-settings";
import { DEPOSIT_SLIPPAGE_BPS, createAtaIdempotentIx, depositSolIx, parseStakePool, quoteDepositSol, tokenAta } from "./stake-pool";
import {
  JITOSOL,
  extendStakeAdvanceIx,
  instantRedeemStakeIx,
  openStakePositionIx,
  redeemStakeIx,
  stakePositionPda,
  stakeTokenOf,
  takeStakeAdvanceIx,
  unlockStakeIx,
  type StakeToken,
} from "./stake";
import {
  createSimSolAtaIx,
  extendNativeAdvanceIx,
  faucetIx,
  instantRedeemIx,
  openNativePositionIx,
  positionPda,
  redeemIx,
  setBreakIx,
  setEntryLimitIx,
  setSelfExclusionIx,
  setExtendLimitIx,
  takeNativeAdvanceIx,
  unlockIx,
  type NativeInfo,
} from "./native";
import { extendFailure, plainError } from "@/lib/errors";

/** On mainnet the Player pays their own fees: there is no faucet to top the wallet up. */
const ensureSol: typeof ensureDevnetSol = (...args) => (CLUSTER.yieldModel === "real" ? Promise.resolve() : ensureDevnetSol(...args));

/** The staking token a Position or Source holds; throws for a token this app version cannot read. */
function tokenFor(mint: PublicKey | null | undefined): StakeToken | null {
  if (!mint) return null;
  const token = stakeTokenOf(mint);
  if (!token) throw new Error("This Position holds a staking token this version of the app does not support yet.");
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
  const [account] = await Promise.all([
    getChain().base.getAccountInfo(BlockPuzzleChain.coreAccount(signer.publicKey)),
    ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees")),
  ]);
  onStep("Getting simSOL");
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
  onStep: (s: string) => void = () => undefined,
): Promise<{ signature: string; position: string }> {
  onStep("Preparing");
  const [account] = await Promise.all([
    getChain().base.getAccountInfo(BlockPuzzleChain.coreAccount(signer.publicKey)),
    ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees")),
  ]);
  const nonce = BigInt(Date.now());
  const position = await positionPda(signer.publicKey, nonce);
  const ixs = [openNativePositionIx(signer.publicKey, nonce, simSolBaseUnits, position), takeNativeAdvanceIx(signer.publicKey, position, 0, months)];
  onStep("Opening the Position");
  const signature = await send(signer, account ? ixs : [await createAccountIx(signer.publicKey), ...ixs]);
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
  onStep: (s: string) => void = () => undefined,
): Promise<string> {
  onStep("Preparing");
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  onStep("Taking the Advance");
  const token = info.stakeRateOpen > 0n ? tokenFor(info.mint) : null;
  return send(signer, [
    token
      ? takeStakeAdvanceIx(signer.publicKey, info.position, info.advances, months, info.openAdvance, token)
      : takeNativeAdvanceIx(signer.publicKey, info.position, info.advances, months, info.openAdvance),
  ]);
}

/** Extend the open Advance of a locked SOL Position with `extend_native_advance`. The Gemas land in the owner's Holding of the same Source. */
export async function extendAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  info: NativeInfo,
  extraMonths: number,
  onStep: (s: string) => void = () => undefined,
): Promise<string> {
  if (!info.source) throw new Error("This Position has no open Advance.");
  onStep("Preparing");
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  onStep("Extending the Advance");
  try {
    const token = info.stakeRateOpen > 0n ? tokenFor(info.mint) : null;
    return await send(signer, [
      token
        ? extendStakeAdvanceIx(signer.publicKey, info.position, info.source.index, extraMonths, token)
        : extendNativeAdvanceIx(signer.publicKey, info.position, info.source.index, extraMonths),
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
 * Redeem Gemas of one native Source into simSOL, or into the staking token when `stakeMint` names one (mainnet).
 * The token account is created if the holder has none.
 */
export const redeemNative = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint, stakeMint: PublicKey | null = null) => {
  const token = tokenFor(stakeMint);
  return send(
    signer,
    token
      ? [createAtaIdempotentIx(signer.publicKey, signer.publicKey, token.mint), redeemStakeIx(signer.publicKey, position, source, gemas, token)]
      : [createSimSolAtaIx(signer.publicKey, signer.publicKey), redeemIx(signer.publicKey, position, source, gemas)],
  );
};

/**
 * Instant Redeem of won Gemas of one native Source: the `landed` Gemas (yield already in) are redeemed in full first, then the Treasury
 * buys `gemas` still pending and pays simSOL (or the staking token on mainnet) into the holder's token account, all in one transaction.
 */
export const instantRedeemNative = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint, landed: bigint, stakeMint: PublicKey | null = null) => {
  const token = tokenFor(stakeMint);
  const me = signer.publicKey;
  return send(signer, [
    token ? createAtaIdempotentIx(me, me, token.mint) : createSimSolAtaIx(me, me),
    ...(landed > 0n ? [token ? redeemStakeIx(me, position, source, landed, token) : redeemIx(me, position, source, landed)] : []),
    token ? instantRedeemStakeIx(me, position, source, gemas, token) : instantRedeemIx(me, position, source, gemas),
  ]);
};

/** Unlock: the program computes Debt itself, closes the open Advance and returns the Principal with the free yield (in the staking token on mainnet). */
export const unlockNative = (signer: ChainSigner, info: NativeInfo) => {
  const token = info.stakeRateOpen > 0n ? tokenFor(info.mint) : null;
  return send(
    signer,
    token
      ? [createAtaIdempotentIx(signer.publicKey, signer.publicKey, token.mint), unlockStakeIx(signer.publicKey, info.position, info.openAdvance, token)]
      : [unlockIx(signer.publicKey, info.position, info.openAdvance)],
  );
};

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
  token: StakeToken = JITOSOL,
  onStep: (s: string) => void = () => undefined,
): Promise<{ signature: string; position: string }> {
  onStep("Preparing");
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for network fees"));
  const me = signer.publicKey;
  const base = getChain().base;
  const [account, poolInfo] = await Promise.all([base.getAccountInfo(BlockPuzzleChain.coreAccount(me)), deposit.from === "sol" ? base.getAccountInfo(token.pool) : null]);
  const nonce = BigInt(Date.now());
  const position = await stakePositionPda(me, nonce);
  const advance = takeStakeAdvanceIx(me, position, 0, months, null, token);
  const prefix = account ? [] : [await createAccountIx(me)];
  if (deposit.from === "token") {
    onStep("Opening the Position");
    const signature = await send(signer, [...prefix, openStakePositionIx(me, nonce, deposit.shares, position, token), advance]);
    return { signature, position: position.toBase58() };
  }
  const view = poolInfo && poolInfo.owner.equals(token.poolProgram) ? parseStakePool(poolInfo.data) : null;
  if (!view) throw new Error("The staking pool could not be read. Try again in a moment.");
  const quote = quoteDepositSol(deposit.lamports, view, DEPOSIT_SLIPPAGE_BPS);
  if (quote.problem) throw new Error(quote.problem);
  onStep("Staking and opening the Position");
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
    throw new Error(`Your Position is open, but the Advance did not go through: ${friendlyError(e)} Take it from the Position card.`);
  }
  return { signature, position: position.toBase58() };
}

const stakeTokenAccount = (owner: PublicKey, token: StakeToken) => tokenAta(owner, token.mint);
