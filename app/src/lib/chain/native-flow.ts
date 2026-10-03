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
  openNativePositionIx,
  positionPda,
  redeemIx,
  sweepNativeSurplusIx,
  takeNativeAdvanceIx,
  unlockIx,
  type NativeInfo,
} from "./native";

/** The program's own message from a failed transaction's logs ("Error Message: ..."), else the first line. */
export function friendlyError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const m = /Error Message: ([^\n]+)/.exec(text);
  if (m) return m[1].replace(/\.$/, "");
  return text.split("\n")[0].replace(/^base tx failed \S+: /, "").slice(0, 200);
}

const send = (signer: ChainSigner, ixs: TransactionInstruction[]) => getChain().sendBase(signer, ixs);

/**
 * SIMULATED faucet: 10 simSOL per hour. Tops up SOL for fees first when the wallet is nearly empty, and
 * creates the Account in the same transaction when there is none, so a new wallet signs once.
 */
export async function getTestSimSol(signer: ChainSigner, getToken: GetToken, onStep: (s: string) => void = () => undefined): Promise<string> {
  const [account] = await Promise.all([
    getChain().base.getAccountInfo(BlockPuzzleChain.coreAccount(signer.publicKey)),
    ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for fees")),
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
    ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep("Adding SOL for fees")),
  ]);
  const nonce = BigInt(Date.now());
  const position = await positionPda(signer.publicKey, nonce);
  const ixs = [openNativePositionIx(signer.publicKey, nonce, simSolBaseUnits, position), takeNativeAdvanceIx(signer.publicKey, position, 0, months)];
  onStep("Opening the Position");
  const signature = await send(signer, account ? ixs : [await createAccountIx(signer.publicKey), ...ixs]);
  return { signature, position: position.toBase58() };
}

/** Permissionless crank: applies the vault's accrued yield to the Position's Debt. */
export const refreshYield = (signer: ChainSigner, info: NativeInfo) => send(signer, [accrueNativeYieldIx(info.position, info.openAdvance)]);

/** Redeem Gemas of one native Source into simSOL. The token account is created if the holder has none. */
export const redeemNative = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint) =>
  send(signer, [createSimSolAtaIx(signer.publicKey, signer.publicKey), redeemIx(signer.publicKey, position, source, gemas)]);

/** Unlock: crank first so the Debt the program sees is current, then return the Principal. */
export const unlockNative = (signer: ChainSigner, info: NativeInfo) =>
  send(signer, [accrueNativeYieldIx(info.position, info.openAdvance), unlockIx(signer.publicKey, info.position)]);

/** After Unlock: releases whatever the vault holds beyond the yield still owed to holders. */
export const sweepNative = (signer: ChainSigner, info: NativeInfo) => send(signer, [sweepNativeSurplusIx(signer.publicKey, info.position)]);
