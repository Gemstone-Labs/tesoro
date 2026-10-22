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

/** Client side of /api/admin/orders: the open Instant Redeem orders, signed with the admin's wallet. */
export async function fetchOrders(signer: ChainSigner, getToken: () => Promise<string | null>): Promise<import("@/server/admin/orders").OrdersReply> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-admin", "orders", address, ts, nonce, {})));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/admin/orders", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step: "orders", address, ts, nonce, signature: b64(signature) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 403 ? "This wallet is not on the admin list." : (json.error ?? "That didn’t go through. Try again in a moment."));
  return json;
}

/** Client side of /api/admin/listing: one signed call (list, accept or reject, record a payment, feature). */
export async function callListing(
  signer: ChainSigner,
  getToken: () => Promise<string | null>,
  step: "studios" | "studio-decide" | "studio-pay" | "studio-feature",
  fields: Partial<Record<"id" | "intent" | "code" | "version" | "months" | "position" | "enabled", string | number>> = {},
): Promise<import("@/server/listing/service").AdminReply> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-admin", step, address, ts, nonce, fields)));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/admin/listing", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, nonce, signature: b64(signature), ...fields }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 403 ? "This wallet is not on the admin list." : (json.error ?? "That didn’t go through. Try again in a moment."));
  return json;
}
