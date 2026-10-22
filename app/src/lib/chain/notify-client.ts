import type { ChainSigner } from "@/games/block-puzzle/chain";
import { newNonce, signedMessage, type SignedFields } from "./signed-request";

/** Client side of the email settings route (app/src/app/api/notify/route.ts). */
export interface NotifyStatus {
  email: string | null;
  verified: boolean;
  enabled: boolean;
}

export type NotifyStep = "status" | "set-email" | "set-enabled";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export async function notifyCall(step: NotifyStep, signer: ChainSigner, getToken: () => Promise<string | null>, body: SignedFields = {}): Promise<NotifyStatus> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-notify", step, address, ts, nonce, body)));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/notify", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, nonce, signature: b64(signature), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "That didn’t go through. Try again in a moment.");
  return json as NotifyStatus;
}

/** False when the server has no email set up (no signature needed to ask). */
export async function notifyReady(): Promise<boolean> {
  const res = await fetch("/api/notify");
  const json = await res.json().catch(() => ({}));
  return res.ok && json.ready === true;
}
