import { PublicKey } from "@solana/web3.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import nacl from "tweetnacl";
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

export interface AuthEnv {
  privyAppId?: string;
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
  };
};

export interface SignedRequest<S extends string> {
  step: S;
  address: PublicKey;
  fields: SignedFields;
  /** The verified Privy user id; null only off production without Privy, or with the dev wallet. */
  sub: string | null;
}

const ENVELOPE = ["step", "address", "ts", "nonce", "signature"];

/**
 * Checks a signed route call. The wallet signed `signedMessage(...)` over every field of the body
 * with a fresh, single-use nonce; with Privy configured a valid access token is also required, and in
 * production Privy must be configured.
 */
export async function verifySignedRequest<S extends string>(
  scope: SignedScope,
  steps: readonly S[],
  raw: unknown,
  authorization: string | null,
  opts: { nonces: NonceStore; env?: AuthEnv; now?: number },
): Promise<SignedRequest<S>> {
  const env = opts.env ?? envFromProcess();
  const now = opts.now ?? Date.now();
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new DemoHttpError(400, "bad-request", "Malformed request.");
  const { step, address, ts, nonce, signature } = body;
  if (!steps.includes(step as S) || typeof address !== "string" || typeof ts !== "number" || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce) || typeof signature !== "string") {
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
  try {
    pubkey = new PublicKey(address);
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed address.");
  }

  if (!env.privyAppId && env.production) throw new DemoHttpError(503, "not-configured", "Sign-in is not configured on this server.");
  if (Math.abs(now - ts) > WINDOW_MS) throw new DemoHttpError(401, "stale", "Request expired. Try again.");
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(new TextEncoder().encode(signedMessage(scope, step as string, address, ts, nonce, fields)), Buffer.from(signature, "base64"), pubkey.toBytes());
  } catch {
    ok = false;
  }
  if (!ok) throw new DemoHttpError(401, "bad-signature", "Wallet signature did not verify.");

  let sub: string | null = null;
  if (env.privyAppId && !env.devWallet) {
    const token = authorization?.replace(/^Bearer\s+/i, "");
    sub = token ? await env.verifyToken(token, env.privyAppId) : null;
    if (!sub) throw new DemoHttpError(401, "signed-out", "Sign in to continue.");
  }
  if (!opts.nonces.use(nonce, ts + WINDOW_MS, now)) throw new DemoHttpError(401, "replayed", "Request already used. Try again.");
  return { step: step as S, address: pubkey, fields, sub };
}
