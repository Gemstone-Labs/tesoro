import "./polyfill";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { createAccountIx } from "./match-flow";
import { ensureSol, type GetToken } from "./demo-client";
import {
  accrueNativeYieldIx,
  createSimSolAtaIx,
  faucetIx,
  instantRedeemIx,
  openNativePositionIx,
  positionPda,
  redeemIx,
  sweepNativeSurplusIx,
  takeNativeAdvanceIx,
  unlockIx,
  type NativeInfo,
} from "./native";
import { plainError } from "@/lib/errors";

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
  return send(signer, [accrueNativeYieldIx(info.position, info.openAdvance), takeNativeAdvanceIx(signer.publicKey, info.position, info.advances, months)]);
}

/** Permissionless crank: applies the vault's accrued yield to the Position's Debt. */
export const refreshYield = (signer: ChainSigner, info: NativeInfo) => send(signer, [accrueNativeYieldIx(info.position, info.openAdvance)]);

/** Redeem Gemas of one native Source into simSOL. The token account is created if the holder has none. */
export const redeemNative = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint) =>
  send(signer, [createSimSolAtaIx(signer.publicKey, signer.publicKey), redeemIx(signer.publicKey, position, source, gemas)]);

/**
 * Instant Redeem of won Gemas of one native Source: the `landed` Gemas (yield already in) are redeemed in full first, then the treasury
 * vault buys `gemas` still pending and pays simSOL into the holder's token account, all in one transaction.
 */
export const instantRedeemNative = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint, landed: bigint) =>
  send(signer, [
    createSimSolAtaIx(signer.publicKey, signer.publicKey),
    ...(landed > 0n ? [redeemIx(signer.publicKey, position, source, landed)] : []),
    instantRedeemIx(signer.publicKey, position, source, gemas),
  ]);

/** Unlock: crank first so the Debt the program sees is current, then return the Principal. */
export const unlockNative = (signer: ChainSigner, info: NativeInfo) =>
  send(signer, [accrueNativeYieldIx(info.position, info.openAdvance), unlockIx(signer.publicKey, info.position)]);

/** After Unlock: releases whatever the vault holds beyond the yield still owed to holders. */
export const sweepNative = (signer: ChainSigner, info: NativeInfo) => send(signer, [sweepNativeSurplusIx(signer.publicKey, info.position)]);
