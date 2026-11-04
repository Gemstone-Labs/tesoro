import { VersionedMessage, VersionedTransaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { walletOf, type ChainSigner } from "@/games/block-puzzle/chain";
import { assertSeatMay } from "@/lib/seat/seat-scope";
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

/** Reads the Privy identity token (set by the sign-in provider). The token-only entry step sends it to show the wallet is the user's. */
let identityTokenGetter: (() => Promise<string | null>) | null = null;
export const setIdentityTokenGetter = (get: (() => Promise<string | null>) | null) => {
  identityTokenGetter = get;
};

async function post<T>(path: string, body: unknown, token: string | null, identity: string | null = null): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(identity ? { "privy-id-token": identity } : {}) },
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
  /** A join built without its table assignment (it did not fit, or none was free): ask for the table once the join confirms (`requestTable`). */
  table?: boolean;
}

const bytesOf = (b64text: string) => Uint8Array.from(atob(b64text), (c) => c.charCodeAt(0));

const intentOf = (ixs: TransactionInstruction[]) =>
  JSON.stringify({
    ixs: ixs.map((ix) => ({
      program: ix.programId.toBase58(),
      keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
      data: btoa(String.fromCharCode(...ix.data)),
    })),
  });

/**
 * The signed request both build routes take: the instructions as JSON, signed by the wallet. A seat key signs for its wallet
 * instead: `address` stays the wallet, `signer` is the key and `match` the Match it plays; only a Match's finish steps are
 * ever asked of the server this way.
 */
async function signedIntent(signer: ChainSigner, step: string, ixs: TransactionInstruction[]) {
  const intent = intentOf(ixs);
  const address = walletOf(signer).toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  if (signer.seatMatch) {
    assertSeatMay(ixs);
    const match = signer.seatMatch.toBase58();
    const key = signer.publicKey.toBase58();
    const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-sponsor", step, address, ts, nonce, { intent, match }, key)));
    return { step, address, signer: key, match, ts, nonce, signature: b64(signature), intent };
  }
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-sponsor", step, address, ts, nonce, { intent })));
  return { step, address, ts, nonce, signature: b64(signature), intent };
}

/** The request of the token-only `entry` step: no wallet signature, the Privy login (and identity token) vouch for it. */
function entryIntent(signer: ChainSigner, ixs: TransactionInstruction[]) {
  return { step: "entry", address: walletOf(signer).toBase58(), ts: Date.now(), nonce: newNonce(), intent: intentOf(ixs) };
}

/** Asks the server to build the message for `ixs` (the signer authenticates the request). */
export async function sponsorBuild(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[]): Promise<SponsorBuild> {
  const body = await signedIntent(signer, "build", ixs);
  const token = await getToken().catch(() => null);
  return post<SponsorBuild>("/api/sponsor/build", body, token);
}

/** The server turned the login-only entry down (identity tokens are off, or the wallet is not the user's): the wallet vouches instead. */
const entryRefused = (e: unknown): boolean => e instanceof SponsorError && (e.code === "wallet-not-yours" || e.code === "signed-out" || e.code === "bad-request");
let entryTokenOff = 0;
const ENTRY_TOKEN_RETRY_MS = 5 * 60_000;
/** Test hook: forget that the login-only entry was refused. */
export const resetEntryTokenState = () => {
  entryTokenOff = 0;
};

/**
 * Builds an entry (open, join, Ticket steps, grows) vouched for by the Privy login alone, so the wallet signs only the
 * transaction. When the server refuses (identity tokens are not on in the Privy dashboard) the wallet-signed `build` is used,
 * and that is remembered for a few minutes so the following steps do not ask twice.
 */
export async function sponsorBuildEntry(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], now = Date.now()): Promise<SponsorBuild> {
  if (now - entryTokenOff > ENTRY_TOKEN_RETRY_MS) {
    const [token, identity] = await Promise.all([getToken().catch(() => null), identityTokenGetter ? identityTokenGetter().catch(() => null) : null]);
    // with no sign-in provider (the local dev wallet) there is neither token: the dev server accepts that, production refuses and the wallet vouches
    if (!identityTokenGetter || (token && identity)) {
      try {
        return await post<SponsorBuild>("/api/sponsor/build", entryIntent(signer, ixs), token, identity);
      } catch (e) {
        if (!entryRefused(e)) throw e;
        entryTokenOff = now;
      }
    }
  }
  return sponsorBuild(signer, getToken, ixs);
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
export async function sponsoredSend(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], opts: { entry?: boolean } = {}): Promise<string> {
  return (await sponsoredSendBuilt(signer, getToken, ixs, opts)).sig;
}

/** `sponsoredSend` that also says whether the join travelled without its table (`requestTable` then follows). */
export async function sponsoredSendBuilt(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], opts: { entry?: boolean } = {}): Promise<{ sig: string; table: boolean }> {
  if (!signer.signSerialized) throw new SponsorError("This wallet cannot take part in free transactions.", "unsupported-wallet", 400);
  const built = await (opts.entry ? sponsorBuildEntry : sponsorBuild)(signer, getToken, ixs);
  return { sig: await sponsorSubmit(await sponsorSign(signer, built), built), table: !!built.table };
}

/**
 * Sends a `join_match` the wallet pays for, with the Match's table assigned in the same transaction: the server adds the
 * assignment and signs it as the Table operator, the wallet signs and sends. Throws SponsorError when it cannot (no free
 * table, no operator configured, a wallet that cannot sign serialized transactions): the caller then sends the join alone.
 */
export async function assignedSend(signer: ChainSigner, getToken: GetToken, ixs: TransactionInstruction[], send: (signed: Uint8Array) => Promise<string>, now = Date.now()): Promise<string> {
  if (!signer.signSerialized) throw new SponsorError("This wallet cannot take part in table assignment.", "unsupported-wallet", 400);
  const token = await getToken().catch(() => null);
  const identity = identityTokenGetter ? await identityTokenGetter().catch(() => null) : null;
  let built: { tx: string; meta: string; mac: string } | null = null;
  if ((!identityTokenGetter || (token && identity)) && now - entryTokenOff > ENTRY_TOKEN_RETRY_MS) {
    try {
      built = await post("/api/sponsor/assign", entryIntent(signer, ixs), token, identity);
    } catch (e) {
      if (!entryRefused(e)) throw e;
      entryTokenOff = now;
    }
  }
  const { tx, meta, mac } = built ?? (await post<{ tx: string; meta: string; mac: string }>("/api/sponsor/assign", await signedIntent(signer, "assign", ixs), token));
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

/**
 * Asks for the table of a Match whose join went out without one (`Built.table`, or the keeper is off): signed by the wallet or by
 * the Match's seat key. The server builds the operator's assignment alone and the relayer sends it. Retries while the join is
 * still confirming or no table is free; resolves true once assigned (or already assigned).
 */
export async function requestTable(signer: ChainSigner, getToken: GetToken, match: PublicKey, tries = 10, waitMs = 2_000): Promise<boolean> {
  const address = walletOf(signer).toBase58();
  for (let i = 0; i < tries; i++) {
    const ts = Date.now();
    const nonce = newNonce();
    const seatKey = signer.seatMatch ? signer.publicKey.toBase58() : undefined;
    const signature = b64(await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-sponsor", "table", address, ts, nonce, { match: match.toBase58() }, seatKey))));
    const body = { step: "table", address, ...(seatKey ? { signer: seatKey } : {}), match: match.toBase58(), ts, nonce, signature };
    try {
      const built = await post<SponsorBuild>("/api/sponsor/build", body, await getToken().catch(() => null));
      const sig = await sponsorSubmit(await sponsorSign(signer, built), built);
      void confirmAssignment(built.meta, built.mac);
      return sig.length > 0;
    } catch (e) {
      if (e instanceof SponsorError && e.code === "assigned") return true;
      if (!(e instanceof SponsorError) || (e.code !== "no-table" && e.code !== "join-pending")) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return false;
}
