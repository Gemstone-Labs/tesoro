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
    return this.code === "sponsor-paused" || this.code === "sponsor-empty" || this.code === "setup-already-funded" || this.code === "no-delivery-fee" || this.code === "bridge-send-limit";
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
  /** Address lookup tables the server compiles with: a page sizes a chunk against the same ones. */
  tables?: string[];
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

/** The signed request both build routes take: the instructions as JSON, signed by the wallet. */
async function signedIntent(signer: ChainSigner, step: string, ixs: TransactionInstruction[]) {
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
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-sponsor", step, address, ts, nonce, { intent })));
  return { step, address, ts, nonce, signature: b64(signature), intent };
}

/** Asks the server to build the message for `ixs` (the signer authenticates the request). */
export async function sponsorBuild(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[]): Promise<SponsorBuild> {
  const body = await signedIntent(signer, "build", ixs);
  const token = await getToken().catch(() => null);
  return post<SponsorBuild>("/api/sponsor/build", body, token);
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

/**
 * Sends a `join_match` the wallet pays for, with the Match's table assigned in the same transaction: the server adds the
 * assignment and signs it as the Table operator, the wallet signs and sends. Throws SponsorError when it cannot (no free
 * table, no operator configured, a wallet that cannot sign serialized transactions): the caller then sends the join alone.
 */
export async function assignedSend(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], send: (signed: Uint8Array) => Promise<string>): Promise<string> {
  if (!signer.signSerialized) throw new SponsorError("This wallet cannot take part in table assignment.", "unsupported-wallet", 400);
  const token = await getToken().catch(() => null);
  const { tx, meta, mac } = await post<{ tx: string; meta: string; mac: string }>("/api/sponsor/assign", await signedIntent(signer, "assign", ixs), token);
  const signature = await send(await signer.signSerialized(bytesOf(tx)));
  void confirmAssignment(meta, mac);
  return signature;
}

/** Tells the server the join went out so it can claim the table once the Assignment is on base; it asks a few times, and never fails the join. */
async function confirmAssignment(meta: string, mac: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    try {
      if ((await post<{ confirmed: boolean }>("/api/sponsor/assign/confirm", { meta, mac }, null)).confirmed) return;
    } catch {
      return;
    }
  }
}
