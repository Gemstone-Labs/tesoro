import type { ChainSigner } from "@/games/block-puzzle/chain";
import { newNonce, signedMessage } from "./signed-request";

/** Client side of the 18+ route (app/src/app/api/age/route.ts). */
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export async function ageCall(step: "status" | "confirm", signer: ChainSigner, getToken: () => Promise<string | null>): Promise<boolean> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-age", step, address, ts, nonce, {})));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/age", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, nonce, signature: b64(signature) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "That didn’t go through. Try again in a moment.");
  return json.confirmed === true;
}
