import { PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import coreIdl from "../lib/chain/idl/tesoro_core.json";
import { OVERFLOW_DISC, OVERFLOW_OWNER_AT } from "../lib/chain/overflow";
import { gpaRpc } from "../lib/chain/rpc-config";
import { WindowLimiter } from "./rate-limit";

/**
 * The only list queries the app makes, all Anchor `.all()` on tesoro_core (src/lib/chain/read.ts,
 * recent.ts, backing.ts): the account discriminator at offset 0, plus an owner key at `ownerOffset`
 * for Accounts and Positions. Owner-filtered queries are answered from the unfiltered list, so the
 * upstream sees at most one query per account type whatever the browser sends.
 */
const LISTS: Record<string, { ownerOffset: number | null; disc?: number[] }> = {
  MatchState: { ownerOffset: null },
  RequestState: { ownerOffset: null },
  OfferState: { ownerOffset: null },
  // TesoroAccount: disc 8 + bump 1, then `authority`.
  TesoroAccount: { ownerOffset: 9 },
  // PositionState: disc 8 + bump 1 + position_id 32, then `inner.owner`.
  PositionState: { ownerOffset: 41 },
  // OverflowHead: disc 8 + payer 32 + kind 1 + id 40, then the line store, whose header keeps the owner Account at byte 8.
  // No instruction names this account type, so the IDL has no discriminator for it.
  OverflowHead: { ownerOffset: OVERFLOW_OWNER_AT, disc: [...OVERFLOW_DISC] },
};

const CORE = coreIdl.address;
const SHAPES = new Map([
  ...coreIdl.accounts
    .filter((a) => a.name in LISTS)
    .map((a) => [utils.bytes.bs58.encode(Uint8Array.from(a.discriminator)), { name: a.name, ...LISTS[a.name] }] as const),
  ...Object.entries(LISTS)
    .filter(([, l]) => l.disc)
    .map(([name, l]) => [utils.bytes.bs58.encode(Uint8Array.from(l.disc!)), { name, ...l }] as const),
]);

export interface GpaQuery {
  /** The upstream query: tesoro_core, discriminator memcmp only. */
  program: string;
  disc: string;
  /** Rows kept from that list: the 32 bytes at `offset` equal `key`. */
  owner: { offset: number; key: PublicKey } | null;
}

export class GpaInputError extends Error {}

export class GpaUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Accepts exactly `program=<tesoro_core>&filter=m:0:<disc>[&filter=m:<ownerOffset>:<pubkey>]`; anything else is a 400. */
export function parseQuery(params: URLSearchParams): GpaQuery {
  for (const k of params.keys()) if (k !== "program" && k !== "filter") throw new GpaInputError("Unsupported list query.");
  if (params.getAll("program").length !== 1 || params.get("program") !== CORE) throw new GpaInputError("Unsupported list query.");
  const [first, second, ...rest] = params.getAll("filter");
  const shape = first?.startsWith("m:0:") ? SHAPES.get(first.slice(4)) : undefined;
  if (!shape || rest.length) throw new GpaInputError("Unsupported list query.");
  const disc = first.slice(4);
  if (second === undefined) return { program: CORE, disc, owner: null };
  const m = /^m:(\d+):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(second);
  if (!m || shape.ownerOffset === null || Number(m[1]) !== shape.ownerOffset) throw new GpaInputError("Unsupported list query.");
  let key: PublicKey;
  try {
    key = new PublicKey(m[2]);
  } catch {
    throw new GpaInputError("Unsupported list query.");
  }
  if (key.toBase58() !== m[2]) throw new GpaInputError("Unsupported list query.");
  return { program: CORE, disc, owner: { offset: shape.ownerOffset, key } };
}

type Row = { pubkey: string; account: { data: [string, string] } };

const FRESH_MS = 4_000;
const STALE_MS = 120_000;
/** Upstream fetch timeout. A shared call older than this is dead (its invocation was frozen mid-flight on Vercel) and is replaced, never awaited. */
const UPSTREAM_MS = 20_000;

interface Entry {
  /** When the rows were fetched; null until the first fetch succeeds. */
  at: number | null;
  rows: Row[];
  inflight: Promise<void> | null;
  /** When `inflight` started. */
  since: number;
}

export interface ListCacheOptions {
  fetch?: typeof fetch;
  url?: () => string;
  now?: () => number;
}

/**
 * Cached lists: fresh for 4s, then stale-while-revalidate for 2 min; one upstream call per list at a
 * time, shared by every caller. After an upstream failure (or during the 429 backoff) any cached
 * rows are served however old; only a list never fetched answers with an error.
 */
export function createListCache(opts: ListCacheOptions = {}) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const url = opts.url ?? (() => gpaRpc(process.env.TESORO_GPA_RPC));
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry>();
  let backoffUntil = 0;
  let backoffStep = 0;
  let upstreamCalls = 0;

  function rateLimited(): never {
    backoffStep = Math.min(backoffStep + 1, 5);
    backoffUntil = now() + 2_000 * 2 ** backoffStep;
    throw new GpaUpstreamError("Rate limited upstream.", 429);
  }

  async function fetchUpstream(q: GpaQuery, owned = false): Promise<Row[]> {
    upstreamCalls++;
    console.log(`[gpa] upstream #${upstreamCalls} list=${SHAPES.get(q.disc)?.name}${owned ? " owner" : ""}`);
    const filters: object[] = [{ memcmp: { offset: 0, bytes: q.disc } }];
    if (owned && q.owner) filters.push({ memcmp: { offset: q.owner.offset, bytes: q.owner.key.toBase58() } });
    const cfg = { encoding: "base64", commitment: "confirmed", filters };
    const res = await doFetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [q.program, cfg] }),
      signal: AbortSignal.timeout(UPSTREAM_MS),
    });
    if (res.status === 429) rateLimited();
    if (!res.ok) throw new GpaUpstreamError(`Upstream status ${res.status}.`, 502);
    const body = (await res.json()) as { result?: Row[]; error?: { code?: number } };
    if (body.error) {
      if (body.error.code === 429 || body.error.code === -32005) rateLimited();
      throw new GpaUpstreamError("Upstream list query failed.", 502);
    }
    backoffStep = 0;
    return body.result ?? [];
  }

  function refresh(q: GpaQuery, entry: Entry): Promise<void> {
    if (!entry.inflight || now() - entry.since > UPSTREAM_MS) {
      const p: Promise<void> = fetchUpstream(q)
        .then((rows) => {
          entry.rows = rows;
          entry.at = now();
        })
        .finally(() => {
          if (entry.inflight === p) entry.inflight = null;
        });
      p.catch(() => undefined);
      entry.inflight = p;
      entry.since = now();
    }
    return entry.inflight;
  }

  /** `refresh`, but the caller stops waiting after the upstream timeout even if the abort never fires. */
  function refreshBounded(q: GpaQuery, entry: Entry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GpaUpstreamError("Upstream list query timed out.", 504)), UPSTREAM_MS + 2_000);
    });
    return Promise.race([refresh(q, entry), late]).finally(() => clearTimeout(timer));
  }

  async function list(q: GpaQuery): Promise<Row[]> {
    let entry = cache.get(q.disc);
    if (!entry) {
      entry = { at: null, rows: [], inflight: null, since: 0 };
      cache.set(q.disc, entry);
    }
    const hasData = entry.at !== null;
    const age = now() - (entry.at ?? 0);
    if (hasData && age < FRESH_MS) return entry.rows;
    const blocked = now() < backoffUntil;
    if (hasData && (age < STALE_MS || blocked)) {
      if (!blocked) void refresh(q, entry);
      return entry.rows;
    }
    if (blocked) throw new GpaUpstreamError("Rate limited upstream.", 429);
    try {
      await refreshBounded(q, entry);
    } catch (e) {
      if (hasData) return entry.rows;
      throw e;
    }
    return entry.rows;
  }

  return {
    /**
     * One owner's rows straight from upstream (discriminator + owner memcmp), never cached and never touching the shared lists:
     * what an Account asks for right after its own transaction. Throws on an upstream failure.
     */
    async getOwnedFresh(q: GpaQuery): Promise<Row[]> {
      if (!q.owner) throw new GpaInputError("Unsupported list query.");
      if (now() < backoffUntil) throw new GpaUpstreamError("Rate limited upstream.", 429);
      return fetchUpstream(q, true);
    },
    async getAccounts(q: GpaQuery): Promise<Row[]> {
      const rows = await list(q);
      if (!q.owner) return rows;
      const { offset, key } = q.owner;
      const want = key.toBuffer();
      return rows.filter((r) => Buffer.from(r.account.data[0], "base64").subarray(offset, offset + 32).equals(want));
    },
    retryAfterSecs: () => Math.max(1, Math.ceil((backoffUntil - now()) / 1000)),
    upstreamCalls: () => upstreamCalls,
  };
}

const lists = createListCache();
export const getAccounts = lists.getAccounts;
export const retryAfterSecs = lists.retryAfterSecs;

export const getOwnedFresh = lists.getOwnedFresh;

/** Per client (IP): the Lobby polls a few lists every few seconds per tab; this leaves room for a shared NAT. */
const perClient = new WindowLimiter(600, 60_000);

/** The caller's IP as the proxy reports it (Vercel sets `x-forwarded-for`), else one shared bucket. */
export function clientKey(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
}

export const takeClient = (key: string) => perClient.take(key);

/** `?fresh=1` reads per client and Account: each costs the upstream one filtered query. Beyond it the cached lists answer. */
const freshReads = new WindowLimiter(4, 60_000);
export const takeFresh = (client: string, authority: string) => freshReads.take(`${client}:${authority}`);
