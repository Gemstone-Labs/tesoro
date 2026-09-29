import "./polyfill";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { ensureReady } from "./match-flow";
import type { GetToken } from "./demo-client";
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

/** SIMULATED faucet: 10 simSOL per hour. Needs SOL for fees and the Account first. */
export async function getTestSimSol(signer: ChainSigner, getToken: GetToken): Promise<string> {
  await ensureReady(signer, getToken);
  return send(signer, [faucetIx(signer.publicKey)]);
}

/** One transaction: `open_native_position` (deposits simSOL) + `take_native_advance` (the Horizon). */
export async function openPositionWithAdvance(
  signer: ChainSigner,
  getToken: GetToken,
  simSolBaseUnits: bigint,
  months: number,
): Promise<{ signature: string; position: string }> {
  await ensureReady(signer, getToken);
  const nonce = BigInt(Date.now());
  const position = await positionPda(signer.publicKey, nonce);
  const signature = await send(signer, [
    openNativePositionIx(signer.publicKey, nonce, simSolBaseUnits, position),
    takeNativeAdvanceIx(signer.publicKey, position, 0, months),
  ]);
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
