import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "../chain/demo-client";
import { newNonce, signedMessage } from "../chain/signed-request";
import { DEPOSIT_ACK_VERSION } from "./acknowledgment";

/** Client side of the deposit acknowledgment route (app/src/app/api/deposit-ack/route.ts). */
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function call(step: "status" | "confirm", signer: ChainSigner, getToken: GetToken): Promise<boolean> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const version = DEPOSIT_ACK_VERSION;
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-deposit-ack", step, address, ts, nonce, { version })));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/deposit-ack", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, nonce, version, signature: b64(signature) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "That didn’t go through. Try again in a moment.");
  return json.acknowledged === true;
}

/** Has this Account acknowledged the current wording? The server is the source of truth. */
export const depositAckStatus = (signer: ChainSigner, getToken: GetToken): Promise<boolean> => call("status", signer, getToken);

/** Records the acknowledgment of the current wording. Safe to repeat. */
export async function confirmDepositAck(signer: ChainSigner, getToken: GetToken): Promise<void> {
  if (!(await call("confirm", signer, getToken))) throw new Error("That didn’t go through. Try again in a moment.");
}

type CacheStore = Pick<Storage, "getItem" | "setItem">;

const key = (authority: string) => `tesoro:deposit-ack:${DEPOSIT_ACK_VERSION}:${authority}`;

/** This browser remembers an acknowledgment of the current wording. A convenience; never throws. */
export function readDepositAckCache(authority: string, store?: CacheStore): boolean {
  try {
    return (store ?? localStorage).getItem(key(authority)) === "1";
  } catch {
    return false;
  }
}

export function writeDepositAckCache(authority: string, store?: CacheStore) {
  try {
    (store ?? localStorage).setItem(key(authority), "1");
  } catch {
    /* a convenience only */
  }
}
