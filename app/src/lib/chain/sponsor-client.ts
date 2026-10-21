import { VersionedMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "./demo-client";
import { newNonce, signedMessage } from "./signed-request";

/**
 * Client side of the relayer (app/src/app/api/sponsor): the instructions we want paid go to the server, which checks
 * them against its allow-list and sends back a transaction message it built. The wallet signs that message and the
 * server adds its fee-payer signature and sends it. The instructions must name the relayer where they take a `payer`
 * or `caller` (see `sponsorStatus().relayer`); everything else is the Player's own.
 */
export class SponsorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
  /** The server cannot pay right now (paused, floor reached, empty): the Player may send the same instructions and pay the fee. */
  get selfPay(): boolean {
    return this.code === "sponsor-paused" || this.code === "sponsor-empty";
  }
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function post<T>(path: string, body: unknown, token: string | null): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new SponsorError(json.error ?? `Free transactions failed (${res.status})`, json.code ?? "error", res.status);
  return json as T;
}

export interface SponsorStatus {
  relayer: string;
  paused: boolean;
  low: boolean;
}

export async function sponsorStatus(): Promise<SponsorStatus> {
  const res = await fetch("/api/sponsor");
  if (!res.ok) throw new SponsorError("Free transactions are unavailable.", "error", res.status);
  return (await res.json()) as SponsorStatus;
}

export interface SponsorBuild {
  message: string;
  meta: string;
  mac: string;
}

const bytesOf = (b64text: string) => Uint8Array.from(atob(b64text), (c) => c.charCodeAt(0));

/** Asks the server to build the message for `ixs` (the signer authenticates the request). */
export async function sponsorBuild(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[]): Promise<SponsorBuild> {
  const intent = JSON.stringify({
    ixs: ixs.map((ix) => ({
      program: ix.programId.toBase58(),
      keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
      data: btoa(String.fromCharCode(...ix.data)),
    })),
  });
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-sponsor", "build", address, ts, nonce, { intent })));
  const token = await getToken().catch(() => null);
  return post<SponsorBuild>("/api/sponsor/build", { step: "build", address, ts, nonce, signature: b64(signature), intent }, token);
}

/** Adds this wallet's signature to a built message. Returns the serialized transaction, base64. */
export async function sponsorSign(signer: ChainSigner, built: SponsorBuild): Promise<string> {
  if (!signer.signSerialized) throw new SponsorError("This wallet cannot take part in free transactions.", "unsupported-wallet", 400);
  const message = VersionedMessage.deserialize(bytesOf(built.message));
  const unsigned = new VersionedTransaction(message).serialize();
  const needsPlayer = message.staticAccountKeys.slice(1, message.header.numRequiredSignatures).some((k) => k.equals(signer.publicKey));
  return b64(needsPlayer ? await signer.signSerialized(unsigned) : unsigned);
}

/** Sends a signed transaction. The server checks the signatures and the MAC, adds the fee payer's and sends. */
export async function sponsorSubmit(tx: string, built: SponsorBuild): Promise<string> {
  return (await post<{ signature: string }>("/api/sponsor/submit", { tx, meta: built.meta, mac: built.mac }, null)).signature;
}

/** Sends `ixs` with the relayer paying the fee. Resolves with the signature. Throws SponsorError (`selfPay` says to pay instead). */
export async function sponsoredSend(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[]): Promise<string> {
  if (!signer.signSerialized) throw new SponsorError("This wallet cannot take part in free transactions.", "unsupported-wallet", 400);
  const built = await sponsorBuild(signer, getToken, ixs);
  return sponsorSubmit(await sponsorSign(signer, built), built);
}
