import { PublicKey, Transaction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { newNonce, signedMessage, type SignedFields } from "./signed-request";

/**
 * Client side of the temporary demo funding route (app/src/app/api/demo-advance/route.ts).
 * Simulated · demo Advance: replaced by real Position deposits (docs in app/docs/demo-funding.md).
 */
export type DemoStep = "fund" | "advance" | "accrue";
export type GetToken = () => Promise<string | null>;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export class DemoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function demoCall<T = Record<string, unknown>>(
  step: DemoStep,
  signer: ChainSigner,
  getToken: GetToken,
  body: SignedFields = {},
): Promise<T> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-demo", step, address, ts, nonce, body)));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/demo-advance", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, nonce, signature: b64(signature), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new DemoError(json.error ?? `Demo route failed (${res.status})`, json.code ?? "error", res.status);
  return json as T;
}

/** Tops up devnet SOL for fees and rent when the wallet is nearly empty (`onFund` fires first). Capped server-side. */
export async function ensureSol(signer: ChainSigner, getToken: GetToken, minLamports: number, onFund?: () => void): Promise<void> {
  const balance = await getChain().base.getBalance(signer.publicKey);
  if (balance >= minLamports) return;
  onFund?.();
  await demoCall("fund", signer, getToken);
  for (let i = 0; i < 20; i++) {
    if ((await getChain().base.getBalance(signer.publicKey)) >= minLamports) return;
    await new Promise((r) => setTimeout(r, 750));
  }
}

export interface DemoAdvanceResult {
  position: string;
  gemas: number;
  transaction: string;
}

/**
 * Simulated · demo Advance: the server opens a simulated Position for this Account (oracle-signed),
 * returns the `take_advance` transaction with the oracle already signed; the Account signs and sends it.
 * Then the server applies a slice of simulated yield so part of the Gemas are redeemable.
 */
export async function takeDemoAdvance(signer: ChainSigner, getToken: GetToken): Promise<{ gemas: number; signature: string }> {
  const r = await demoCall<DemoAdvanceResult>("advance", signer, getToken);
  const tx = Transaction.from(Uint8Array.from(atob(r.transaction), (c) => c.charCodeAt(0)));
  const signed = await signer.signTransaction(tx);
  const signature = await getChain().sendSigned(signed);
  await demoCall("accrue", signer, getToken, { position: r.position }).catch(() => undefined);
  return { gemas: r.gemas, signature };
}

export const isPk = (s: string) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
};
