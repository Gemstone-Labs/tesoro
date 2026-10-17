import { Transaction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { newNonce, signedMessage } from "./signed-request";

/** Client side of the Invite route (app/src/app/api/invite/redeem/route.ts). */
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Asks the server to redeem `code` for this wallet; returns the create-Account transaction the Invite key already signed. */
export async function redeemInviteTx(signer: ChainSigner, getToken: () => Promise<string | null>, code: string): Promise<Transaction> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const fields = { code };
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-invite", "redeem", address, ts, nonce, fields)));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/invite/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step: "redeem", address, ts, nonce, signature: b64(signature), ...fields }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "That didn’t go through. Try again in a moment.");
  return Transaction.from(Uint8Array.from(atob(json.tx), (c) => c.charCodeAt(0)));
}

/** Redeems the code, then the Player signs the co-signed transaction and it is sent: the Account exists afterwards. */
export async function claimInvite(signer: ChainSigner, getToken: () => Promise<string | null>, code: string): Promise<string> {
  const tx = await redeemInviteTx(signer, getToken, code);
  return getChain().sendSigned(await signer.signTransaction(tx));
}
