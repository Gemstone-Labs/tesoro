import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, type PublicKey } from "@solana/web3.js";
import { browserStore } from "../storage";
import { GAME_SERVER_DOWN } from "../errors";

/**
 * The one door to the private rollup. Every Game logs in here, so a page signs in once per wallet per token
 * lifetime (concurrent callers share one login, reloads and tabs reuse the stored token) and never hammers a
 * server that has said "slow down": the rollup bans an IP that keeps logging in, and a retry loop keeps the ban alive.
 */

export type TeeToken = { token: string; expiresAt: number };
type TokenStore = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;
export type TeeAuthDeps = {
  login?: (rpc: string, publicKey: PublicKey, sign: (m: Uint8Array) => Promise<Uint8Array>) => Promise<TeeToken>;
  store?: TokenStore | null;
};

/** The game server cannot be reached for now. Fails at once, with no network call, until `retryAt`. */
export class TeeUnreachableError extends Error {
  override name = "TeeUnreachableError";
  constructor(readonly retryAt: number) {
    super(GAME_SERVER_DOWN);
  }
}

/** A token is reused while it has at least this long left. */
const EXPIRY_MARGIN_MS = 3600_000;
const LOGIN_TRIES = 3;
const RETRY_BASE_MS = 1000;
/** Pause after a ban or rate limit: doubles per repeat, capped. */
const BAN_BASE_MS = 60_000;
const BAN_MAX_MS = 300_000;
/** Pause after a transient failure that survived its retries. */
const FAIL_BASE_MS = 5_000;
const FAIL_MAX_MS = 60_000;
const STORE_PREFIX = "tesoro:tee-token:v1:";

const BANNED = /-32005|temporarily banned|\b429\b|too many requests|rate.?limit/i;
const CANCELLED = /user rejected|rejected the request|user denied|cancelled|canceled/i;

type Cooldown = { until: number; failures: number };
const cooldowns = new Map<string, Cooldown>();
const tokens = new Map<string, TeeToken>();
const logins = new Map<string, Promise<TeeToken>>();
const connections = new Map<string, Promise<Connection>>();

const jitter = (ms: number) => ms * (0.8 + 0.2 * Math.random());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tokenKey = (rpc: string, pk: PublicKey) => `${rpc}|${pk.toBase58()}`;

/** Test hook: forget everything held in memory (the stored token survives, as it does across a reload). */
export function resetTeeAuth(): void {
  cooldowns.clear();
  tokens.clear();
  logins.clear();
  connections.clear();
}

function assertOpen(rpc: string): void {
  const c = cooldowns.get(rpc);
  if (c && Date.now() < c.until) throw new TeeUnreachableError(c.until);
}

function pause(rpc: string, banned: boolean): TeeUnreachableError {
  const failures = (cooldowns.get(rpc)?.failures ?? 0) + 1;
  const [base, max] = banned ? [BAN_BASE_MS, BAN_MAX_MS] : [FAIL_BASE_MS, FAIL_MAX_MS];
  const until = Date.now() + Math.min(max, jitter(base * 2 ** (failures - 1)));
  cooldowns.set(rpc, { until, failures });
  return new TeeUnreachableError(until);
}

export const isBannedText = (text: string): boolean => BANNED.test(text);

function readStored(store: TokenStore | null, key: string): TeeToken | null {
  try {
    const raw = store?.getItem(STORE_PREFIX + key);
    if (!raw) return null;
    const t = JSON.parse(raw) as TeeToken;
    return typeof t.token === "string" && typeof t.expiresAt === "number" ? t : null;
  } catch {
    return null;
  }
}

const fresh = (t: TeeToken | null | undefined): t is TeeToken => !!t && t.expiresAt - Date.now() > EXPIRY_MARGIN_MS;

export function invalidateTeeToken(rpc: string, pk: PublicKey, store: TokenStore | null = browserStore()): void {
  const key = tokenKey(rpc, pk);
  tokens.delete(key);
  connections.delete(key);
  try {
    store?.removeItem?.(STORE_PREFIX + key);
  } catch {
    /* blocked site data */
  }
}

/** A login token for `pk`: from memory, then the stored copy, else one shared login with bounded, backed-off retries. */
export async function teeToken(
  rpc: string,
  pk: PublicKey,
  sign: (m: Uint8Array) => Promise<Uint8Array>,
  deps: TeeAuthDeps = {},
): Promise<TeeToken> {
  const key = tokenKey(rpc, pk);
  const store = deps.store === undefined ? browserStore() : deps.store;
  const mem = tokens.get(key);
  if (fresh(mem)) return mem;
  const stored = readStored(store, key);
  if (fresh(stored)) {
    tokens.set(key, stored);
    return stored;
  }
  const inflight = logins.get(key);
  if (inflight) return inflight;
  assertOpen(rpc);
  const login = deps.login ?? ((r, p, s) => getAuthToken(r, p, s));
  const run = (async () => {
    for (let i = 0; ; i++) {
      try {
        const t = await login(rpc, pk, sign);
        cooldowns.delete(rpc);
        tokens.set(key, t);
        try {
          store?.setItem(STORE_PREFIX + key, JSON.stringify(t));
        } catch {
          /* blocked site data */
        }
        return t;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        if (CANCELLED.test(text) || (e as { code?: number })?.code === 4001) throw e;
        if (BANNED.test(text)) throw pause(rpc, true);
        if (i >= LOGIN_TRIES - 1) throw pause(rpc, false);
        await sleep(jitter(RETRY_BASE_MS * 2 ** i));
      }
    }
  })();
  logins.set(key, run);
  try {
    return await run;
  } finally {
    logins.delete(key);
  }
}

/**
 * A fetch for rollup calls: while the server has said "banned" or "slow down" it fails at once without touching the network,
 * and a banned or rate-limited answer starts that pause.
 */
export function guardedFetch(rpc: string, inner: typeof fetch = (...a) => fetch(...a), onUnauthorized?: () => void): typeof fetch {
  return async (input, init) => {
    assertOpen(rpc);
    const res = await inner(input, init);
    if (res.status === 429) throw pause(rpc, true);
    if (res.status === 401) onUnauthorized?.();
    const len = Number(res.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(len) || len < 1000) {
      const text = await res.clone().text().catch(() => "");
      if (text.length < 1000 && /-32005|temporarily banned/i.test(text)) pause(rpc, true);
      else cooldowns.delete(rpc);
    } else cooldowns.delete(rpc);
    return res;
  };
}

/** One authenticated rollup connection per wallet, shared by every caller and every Game in the page. */
export function openTeeConnection(
  rpc: string,
  ws: string,
  pk: PublicKey,
  sign: (m: Uint8Array) => Promise<Uint8Array>,
): Promise<Connection> {
  const key = tokenKey(rpc, pk);
  const cached = connections.get(key);
  if (cached) return cached;
  const p = teeToken(rpc, pk, sign).then(
    ({ token }) =>
      new Connection(`${rpc}?token=${token}`, {
        wsEndpoint: `${ws}?token=${token}`,
        commitment: "confirmed",
        fetch: guardedFetch(rpc, undefined, () => invalidateTeeToken(rpc, pk)),
      }),
  );
  connections.set(key, p);
  p.catch(() => {
    if (connections.get(key) === p) connections.delete(key);
  });
  return p;
}

/** True when this wallet already has a rollup connection, so reading through it asks for no signature. */
export const hasTeeConnection = (rpc: string, pk: PublicKey): boolean => connections.has(tokenKey(rpc, pk));
