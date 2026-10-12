import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { newNonce, signedMessage, type SignedFields } from "./signed-request";

/** Client side of the devnet SOL top-up route (app/src/app/api/demo-advance/route.ts). */
export type DemoStep = "fund";
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
