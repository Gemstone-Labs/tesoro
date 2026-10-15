import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { ReviewReply } from "@/lib/review/flags";
import { newNonce, signedMessage } from "./signed-request";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Client side of /api/admin/review: signs the request with the admin's wallet. */
export async function fetchReview(signer: ChainSigner, getToken: () => Promise<string | null>): Promise<ReviewReply> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-admin", "review", address, ts, nonce, {})));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/admin/review", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step: "review", address, ts, nonce, signature: b64(signature) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 403 ? "This wallet is not on the review list." : (json.error ?? "That didn’t go through. Try again in a moment."));
  return json as ReviewReply;
}
