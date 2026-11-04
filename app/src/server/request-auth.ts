import { PublicKey } from "@solana/web3.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import nacl from "tweetnacl";
import { accountPda } from "../lib/chain/native";
import { SIGNED_FIELDS, signedMessage, type SignedFields, type SignedScope } from "../lib/chain/signed-request";

export class DemoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const WINDOW_MS = 5 * 60 * 1000;

/** Nonces seen within the time window. In memory, per server process, like the quotas. */
export class NonceStore {
  private readonly seen = new Map<string, number>();

  /** False when `nonce` was already used; otherwise remembers it until `expiresAt`. */
  use(nonce: string, expiresAt: number, now = Date.now()): boolean {
    if (this.seen.size > 10_000) for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    const exp = this.seen.get(nonce);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
}

const jwksByApp = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The Privy user id of a valid access token for this app, else null. */
async function verifyPrivyToken(token: string, appId: string): Promise<string | null> {
  let jwks = jwksByApp.get(appId);
  if (!jwks) jwksByApp.set(appId, (jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`))));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: "privy.io", audience: appId });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** What a Privy identity token vouches for: the user and the wallet addresses linked to it. */
export interface PrivyIdentity {
  sub: string;
  wallets: string[];
}

/**
 * A Privy identity token (the `privy-id-token` header, signed by the same keys as the access token): its `linked_accounts` claim lists
 * the user's wallets. Needs "identity tokens" switched on in the Privy dashboard.
 */
async function verifyPrivyIdentity(token: string, appId: string): Promise<PrivyIdentity | null> {
  let jwks = jwksByApp.get(appId);
  if (!jwks) jwksByApp.set(appId, (jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`))));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: "privy.io", audience: appId });
    const raw = payload.linked_accounts;
    const accounts: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!payload.sub || !Array.isArray(accounts)) return null;
    const wallets = accounts.flatMap((a: { type?: string; address?: string }) => (a?.type === "wallet" && typeof a.address === "string" ? [a.address] : []));
    return { sub: payload.sub, wallets };
  } catch {
    return null;
  }
}

export interface AuthEnv {
  privyAppId?: string;
  /** Reads a Privy identity token; absent means entries cannot be authenticated by the login alone. */
  verifyIdentity?: (token: string, appId: string) => Promise<PrivyIdentity | null>;
  production: boolean;
  /** Local dev wallet (never in production): no Privy token. */
  devWallet: boolean;
  verifyToken: (token: string, appId: string) => Promise<string | null>;
}

export const envFromProcess = (): AuthEnv => {
  const production = process.env.NODE_ENV === "production";
  return {
    privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || undefined,
    production,
    devWallet: !production && process.env.NEXT_PUBLIC_DEV_WALLET === "1",
    verifyToken: verifyPrivyToken,
    verifyIdentity: verifyPrivyIdentity,
  };
};

export interface SignedRequest<S extends string> {
  step: S;
  /** The wallet the request speaks for (its Account derives from it). Never the seat key. */
  address: PublicKey;
  /** The Account of `address`. Identity is always this, whichever key signed. */
  account: PublicKey;
  /** The key that signed: the wallet, or a Seat key on a route that opted in. */
  signer: PublicKey;
  /** True when a Seat key (not the wallet) signed. The route must then check the Match names it for `account`. */
  seat: boolean;
  fields: SignedFields;
  /** The verified Privy user id; null only off production without Privy, or with the dev wallet. */
  sub: string | null;
}

const ENVELOPE = ["step", "address", "ts", "nonce", "signature", "signer"];

export interface VerifyOptions<S extends string> {
  nonces: NonceStore;
  env?: AuthEnv;
  now?: number;
  /**
   * The route accepts a Seat key as the signer (default: no, wallet only). Only Game step admission, presence and the
   * finish requests set it, and each then checks that the Match names the key for the Account.
   */
  seatKey?: boolean;
  /** Steps that carry no wallet signature: the Privy access token alone authenticates the request (the sponsored entry). */
  tokenOnly?: readonly S[];
  /**
   * The `privy-id-token` header. A token-only step needs it: the access token only names the user, so the identity token must
   * show that user owns the wallet the request speaks for.
   */
  identityToken?: string | null;
}

/**
 * Checks a signed route call. The wallet signed `signedMessage(...)` over every field of the body
 * with a fresh, single-use nonce; with Privy configured a valid access token is also required, and in
 * production Privy must be configured. A body that names another `signer` is a Seat key's request: refused
 * unless the route opted in with `seatKey`, otherwise verified against that key over a message that names it.
 */
export async function verifySignedRequest<S extends string>(
  scope: SignedScope,
  steps: readonly S[],
  raw: unknown,
  authorization: string | null,
  opts: VerifyOptions<S>,
): Promise<SignedRequest<S>> {
  const env = opts.env ?? envFromProcess();
  const now = opts.now ?? Date.now();
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new DemoHttpError(400, "bad-request", "Malformed request.");
  const { step, address, ts, nonce, signature } = body;
  const tokenOnly = opts.tokenOnly?.includes(step as S) ?? false;
  if (!steps.includes(step as S) || typeof address !== "string" || typeof ts !== "number" || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce) || (!tokenOnly && typeof signature !== "string")) {
    throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
  const fields: SignedFields = {};
  for (const [k, v] of Object.entries(body)) {
    if (ENVELOPE.includes(k)) continue;
    if (!(SIGNED_FIELDS as readonly string[]).includes(k) || (typeof v !== "string" && typeof v !== "number")) {
      throw new DemoHttpError(400, "bad-request", "Malformed request.");
    }
    fields[k as keyof SignedFields] = v;
  }
  let pubkey: PublicKey;
  let signerKey: PublicKey;
  try {
    pubkey = new PublicKey(address);
    signerKey = body.signer === undefined ? pubkey : new PublicKey(body.signer as string);
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed address.");
  }
  const seat = !signerKey.equals(pubkey);
  if (seat && (!opts.seatKey || tokenOnly)) throw new DemoHttpError(403, "wallet-only", "This needs your wallet.");

  if (!env.privyAppId && env.production) throw new DemoHttpError(503, "not-configured", "Sign-in is not configured on this server.");
  if (Math.abs(now - ts) > WINDOW_MS) throw new DemoHttpError(401, "stale", "Request expired. Try again.");
  if (!tokenOnly) {
    let ok = false;
    try {
      const message = signedMessage(scope, step as string, address, ts, nonce, fields, seat ? signerKey.toBase58() : undefined);
      ok = nacl.sign.detached.verify(new TextEncoder().encode(message), Buffer.from(signature as string, "base64"), signerKey.toBytes());
    } catch {
      ok = false;
    }
    if (!ok) throw new DemoHttpError(401, "bad-signature", seat ? "Seat key signature did not verify." : "Wallet signature did not verify.");
  }

  let sub: string | null = null;
  if (env.privyAppId && !env.devWallet) {
    const token = authorization?.replace(/^Bearer\s+/i, "");
    sub = token ? await env.verifyToken(token, env.privyAppId) : null;
    if (!sub) throw new DemoHttpError(401, "signed-out", "Sign in to continue.");
  }
  if (tokenOnly && env.privyAppId && !env.devWallet) {
    const who = opts.identityToken ? await env.verifyIdentity?.(opts.identityToken, env.privyAppId) : null;
    if (!who || who.sub !== sub || !who.wallets.includes(address)) throw new DemoHttpError(403, "wallet-not-yours", "That wallet is not linked to your sign-in.");
  }
  // Scoped to the key, the wallet and the Match the request names: one nonce cannot be spent for another Account or Match.
  if (!opts.nonces.use(`${signerKey.toBase58()}|${address}|${fields.match ?? ""}|${nonce}`, ts + WINDOW_MS, now)) throw new DemoHttpError(401, "replayed", "Request already used. Try again.");
  return { step: step as S, address: pubkey, account: accountPda(pubkey), signer: signerKey, seat, fields, sub };
}
