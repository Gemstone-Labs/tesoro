import "./polyfill";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { createAccountIx } from "./match-flow";
import { ensureSol, type GetToken } from "./demo-client";
import {
  createSimSolAtaIx,
  extendNativeAdvanceIx,
  faucetIx,
  instantRedeemIx,
  openNativePositionIx,
  positionPda,
  redeemIx,
  setEntryLimitIx,
  setExtendLimitIx,
  sweepNativeSurplusIx,
  takeNativeAdvanceIx,
  unlockIx,
  type NativeInfo,
  type TokenCustody,
} from "./native";
import { createAtaIdempotentIx } from "./stake-pool";
import { accrueYieldIx, loadTokenCustody } from "./stake-market";
import { extendFailure, plainError } from "@/lib/errors";

/** The one line a Player sees for a failed Wallet action (see lib/errors.ts). */
export const friendlyError = plainError;

const send = (signer: ChainSigner, ixs: TransactionInstruction[]) => getChain().sendBase(signer, ixs);

/** A real staking token's custody (stake pool, Treasury vault) or undefined for simSOL, read when the action is sent. */
const tokenOf = (position: PublicKey) => loadTokenCustody(getChain().base, position);

/** Creates the holder's token account for the payout: the Position's staking token, or simSOL. */
const payoutAtaIx = (holder: PublicKey, tok?: TokenCustody) => (tok ? createAtaIdempotentIx(holder, holder, tok.mint) : createSimSolAtaIx(holder, holder));

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
 * Another Advance on a locked Position whose Debt is zero: crank first so the program sees the repaid
 * Debt (it refuses while an Advance is open), then `take_native_advance` as Advance number `info.advances`.
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
  const tok = await tokenOf(info.position);
  return send(signer, [accrueYieldIx(info, tok), takeNativeAdvanceIx(signer.publicKey, info.position, info.advances, months, tok?.mint)]);
}

/**
 * Extend the open Advance of a locked SOL Position: crank first so the program sees the Debt as it stands, then
 * `extend_native_advance`. The Gemas land in the owner's Holding of the same Source.
 */
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
    const tok = await tokenOf(info.position);
    return await send(signer, [
      accrueYieldIx(info, tok),
      extendNativeAdvanceIx(signer.publicKey, info.position, info.source.index, extraMonths, tok?.mint),
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

/** Permissionless crank: applies the vault's accrued yield to the Position's Debt. */
export const refreshYield = async (signer: ChainSigner, info: NativeInfo) => send(signer, [accrueYieldIx(info, await tokenOf(info.position))]);

/** Redeem Gemas of one native Source into simSOL. The token account is created if the holder has none. */
export async function redeemNative(signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint) {
  const tok = await tokenOf(position);
  return send(signer, [payoutAtaIx(signer.publicKey, tok), redeemIx(signer.publicKey, position, source, gemas, tok)]);
}

/**
 * Instant Redeem of won Gemas of one native Source: the `landed` Gemas (yield already in) are redeemed in full first, then the treasury
 * vault buys `gemas` still pending and pays simSOL into the holder's token account, all in one transaction.
 */
export async function instantRedeemNative(signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint, landed: bigint) {
  const tok = await tokenOf(position);
  return send(signer, [
    payoutAtaIx(signer.publicKey, tok),
    ...(landed > 0n ? [redeemIx(signer.publicKey, position, source, landed, tok)] : []),
    instantRedeemIx(signer.publicKey, position, source, gemas, tok),
  ]);
}

/** Unlock: crank first so the Debt the program sees is current, then return the Principal. */
export async function unlockNative(signer: ChainSigner, info: NativeInfo) {
  const tok = await tokenOf(info.position);
  return send(signer, [...(tok ? [payoutAtaIx(signer.publicKey, tok)] : []), accrueYieldIx(info, tok), unlockIx(signer.publicKey, info.position, tok)]);
}

/** After Unlock: releases whatever the vault holds beyond the yield still owed to holders. */
export async function sweepNative(signer: ChainSigner, info: NativeInfo) {
  const tok = await tokenOf(info.position);
  return send(signer, [...(tok ? [payoutAtaIx(signer.publicKey, tok)] : []), sweepNativeSurplusIx(signer.publicKey, info.position, tok)]);
}
