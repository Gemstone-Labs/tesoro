import { PublicKey } from "@solana/web3.js";
import blockPuzzleIdl from "../lib/chain/idl/block_puzzle.json";
import holdemIdl from "../lib/chain/idl/holdem.json";
import coreIdl from "../lib/chain/idl/tesoro_core.json";
import { SIM_LST_ID } from "../lib/chain/native";
import { DEFAULT_GPA_RPC } from "../lib/chain/rpc-config";

/** Our four programs (addresses follow the IDLs and native.ts) plus the LayerZero bridge program. */
const BRIDGE_ID = "5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ";
export const ALLOWED_PROGRAMS = new Set<string>([blockPuzzleIdl.address, holdemIdl.address, coreIdl.address, SIM_LST_ID.toBase58(), BRIDGE_ID]);

export interface GpaQuery {
  program: string;
  filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[];
  slice: { offset: number; length: number } | null;
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

const B58 = /^[1-9A-HJ-NP-Za-km-z]{1,100}$/;

/** Validate `program`, repeated `filter` (`s:<size>` or `m:<offset>:<base58>`) and `slice` (`<offset>:<length>`). */
export function parseQuery(params: URLSearchParams): GpaQuery {
  const program = params.get("program") ?? "";
  if (!ALLOWED_PROGRAMS.has(program)) throw new GpaInputError("Unknown program.");
  const raw = params.getAll("filter");
  if (raw.length > 4) throw new GpaInputError("Too many filters.");
  const filters: GpaQuery["filters"] = raw.map((f) => {
    const [kind, a, b, ...rest] = f.split(":");
    if (rest.length) throw new GpaInputError("Bad filter.");
    if (kind === "s" && a && /^\d{1,6}$/.test(a) && b === undefined) return { dataSize: Number(a) };
    if (kind === "m" && a && b && /^\d{1,4}$/.test(a) && B58.test(b)) return { memcmp: { offset: Number(a), bytes: b } };
    throw new GpaInputError("Bad filter.");
  });
  let slice: GpaQuery["slice"] = null;
  const sl = params.get("slice");
  if (sl) {
    const m = /^(\d{1,6}):(\d{1,6})$/.exec(sl);
    if (!m) throw new GpaInputError("Bad slice.");
    slice = { offset: Number(m[1]), length: Number(m[2]) };
  }
  return { program: new PublicKey(program).toBase58(), filters, slice };
}

const FRESH_MS = 4_000;
const STALE_MS = 120_000;
const MAX_ENTRIES = 300;

interface Entry {
  at: number;
  rows: unknown[];
  inflight: Promise<void> | null;
}
const cache = new Map<string, Entry>();
let backoffUntil = 0;
let backoffStep = 0;
let upstreamCalls = 0;

const upstreamUrl = () => process.env.TESORO_GPA_RPC || DEFAULT_GPA_RPC;

function rateLimited(): never {
  backoffStep = Math.min(backoffStep + 1, 5);
  backoffUntil = Date.now() + 2_000 * 2 ** backoffStep;
  throw new GpaUpstreamError("Rate limited upstream.", 429);
}

async function fetchUpstream(q: GpaQuery): Promise<unknown[]> {
  upstreamCalls++;
  console.log(`[gpa] upstream #${upstreamCalls} program=${q.program.slice(0, 6)} filters=${q.filters.length}`);
  const cfg: Record<string, unknown> = { encoding: "base64", commitment: "confirmed", filters: q.filters };
  if (q.slice) cfg.dataSlice = q.slice;
  const res = await fetch(upstreamUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [q.program, cfg] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) rateLimited();
  if (!res.ok) throw new GpaUpstreamError(`Upstream status ${res.status}.`, 502);
  const body = (await res.json()) as { result?: unknown[]; error?: { code?: number } };
  if (body.error) {
    if (body.error.code === 429 || body.error.code === -32005) rateLimited();
    throw new GpaUpstreamError("Upstream list query failed.", 502);
  }
  backoffStep = 0;
  return body.result ?? [];
}

function refresh(q: GpaQuery, entry: Entry): Promise<void> {
  if (!entry.inflight) {
    entry.inflight = fetchUpstream(q)
      .then((rows) => {
        entry.rows = rows;
        entry.at = Date.now();
      })
      .finally(() => {
        entry.inflight = null;
      });
    entry.inflight.catch(() => undefined);
  }
  return entry.inflight;
}

/** Cached list: fresh for 4s, then stale-while-revalidate for 2min; one upstream call per key at a time. */
export async function getAccounts(q: GpaQuery): Promise<unknown[]> {
  const key = JSON.stringify(q);
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    entry = { at: 0, rows: [], inflight: null };
    cache.set(key, entry);
  }
  const age = Date.now() - entry.at;
  const hasData = entry.at > 0;
  if (hasData && age < FRESH_MS) return entry.rows;
  const blocked = Date.now() < backoffUntil;
  if (hasData && age < STALE_MS) {
    if (!blocked) void refresh(q, entry);
    return entry.rows;
  }
  if (blocked) throw new GpaUpstreamError("Rate limited upstream.", 429);
  await refresh(q, entry);
  return entry.rows;
}

export const retryAfterSecs = () => Math.max(1, Math.ceil((backoffUntil - Date.now()) / 1000));
