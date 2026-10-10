/**
 * Primary .sol (Bonfida SNS) and .eth (ENS) names for wallet addresses, read from the mainnet
 * registries. Read-only; answers are cached in memory so a page of Players costs a few lookups once.
 * Failures are never errors to the caller: a name that cannot be read is simply absent.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, getAddress, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

export interface NameRecord {
  /** Full name with its suffix, e.g. `ana.sol`, `ana.eth`. */
  name: string;
  /** An https image URL from the name's record, when it has one. */
  avatar: string | null;
}

export interface NameRequest {
  solana: string[];
  evm: string[];
}

export interface NameResult {
  solana: Record<string, NameRecord | null>;
  evm: Record<string, NameRecord | null>;
}

/** What a registry answers; the real ones are below, tests pass their own. */
export interface NameSources {
  /** Primary .sol name (without suffix) per wallet, undefined when none or stale. */
  solPrimary(wallets: PublicKey[]): Promise<(string | undefined)[]>;
  /** Primary .eth name whose forward record points back at the address. */
  ensName(address: `0x${string}`): Promise<string | null>;
  ensAvatar(name: string): Promise<string | null>;
}

export const MAX_ADDRESSES = 50;
const TTL_FOUND_MS = 10 * 60_000;
const TTL_NONE_MS = 3 * 60_000;
const TTL_FAILED_MS = 30_000;
const MAX_ENTRIES = 5000;
const NAME_PART = /^[\p{L}\p{N}._-]{1,63}$/u;

type Entry = { at: number; ttl: number; value: NameRecord | null };

export class NameCache {
  private readonly map = new Map<string, Entry>();

  get(key: string, now = Date.now()): { value: NameRecord | null } | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (now - e.at >= e.ttl) {
      this.map.delete(key);
      return undefined;
    }
    return { value: e.value };
  }

  set(key: string, value: NameRecord | null, ttl: number, now = Date.now()) {
    if (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { at: now, ttl, value });
  }
}

/** Only https image URLs reach the browser; anything else (data:, javascript:, http:) is dropped. */
export function safeImageUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("name lookup timed out")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

export function parseRequest(raw: unknown): NameRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const { solana = [], evm = [] } = raw as Record<string, unknown>;
  if (!Array.isArray(solana) || !Array.isArray(evm) || solana.length > MAX_ADDRESSES || evm.length > MAX_ADDRESSES) return null;
  const sol: string[] = [];
  for (const s of solana) {
    if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;
    sol.push(s);
  }
  const eth: string[] = [];
  for (const e of evm) {
    if (typeof e !== "string" || !isAddress(e, { strict: false })) return null;
    eth.push(getAddress(e.toLowerCase()));
  }
  return { solana: [...new Set(sol)], evm: [...new Set(eth)] };
}

export async function resolveNames(req: NameRequest, sources: NameSources, cache: NameCache, now = Date.now()): Promise<NameResult> {
  const out: NameResult = { solana: {}, evm: {} };

  const missSol: PublicKey[] = [];
  for (const a of req.solana) {
    const hit = cache.get(`sol:${a}`, now);
    if (hit) out.solana[a] = hit.value;
    else missSol.push(new PublicKey(a));
  }
  if (missSol.length > 0) {
    let names: (string | undefined)[] | null = null;
    try {
      names = await sources.solPrimary(missSol);
    } catch {
      names = null;
    }
    await Promise.all(
      missSol.map(async (w, i) => {
        const a = w.toBase58();
        if (!names) {
          out.solana[a] = null;
          cache.set(`sol:${a}`, null, TTL_FAILED_MS, now);
          return;
        }
        const part = names[i];
        if (!part || !NAME_PART.test(part)) {
          out.solana[a] = null;
          cache.set(`sol:${a}`, null, TTL_NONE_MS, now);
          return;
        }
        // SDK 4.x cannot read pictures of .sol names (it resolves records under .sns only), so a .sol name carries none.
        const value = { name: `${part}.sol`, avatar: null };
        out.solana[a] = value;
        cache.set(`sol:${a}`, value, TTL_FOUND_MS, now);
      }),
    );
  }

  await Promise.all(
    req.evm.map(async (a) => {
      const hit = cache.get(`eth:${a}`, now);
      if (hit) {
        out.evm[a] = hit.value;
        return;
      }
      try {
        const name = await sources.ensName(a as `0x${string}`);
        if (!name) {
          out.evm[a] = null;
          cache.set(`eth:${a}`, null, TTL_NONE_MS, now);
          return;
        }
        const avatar = await sources.ensAvatar(name).catch(() => null);
        const value = { name, avatar: safeImageUrl(avatar) };
        out.evm[a] = value;
        cache.set(`eth:${a}`, value, TTL_FOUND_MS, now);
      } catch {
        out.evm[a] = null;
        cache.set(`eth:${a}`, null, TTL_FAILED_MS, now);
      }
    }),
  );
  return out;
}

const SOL_RPC = process.env.TESORO_SOL_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const ETH_RPC = process.env.TESORO_ETH_MAINNET_RPC || "https://ethereum-rpc.publicnode.com";
const LOOKUP_MS = 4000;

let real: NameSources | null = null;

/** The mainnet registries: SNS primary domains and ENS reverse records, each checked back. */
export function mainnetSources(): NameSources {
  if (real) return real;
  const sol = new Connection(SOL_RPC, "confirmed");
  const eth = createPublicClient({ chain: mainnet, transport: http(ETH_RPC, { timeout: LOOKUP_MS, retryCount: 1 }) });
  real = {
    async solPrimary(wallets) {
      const { getMultiplePrimaryDomains } = await import("@bonfida/spl-name-service");
      return withTimeout(getMultiplePrimaryDomains(sol, wallets), LOOKUP_MS * 2);
    },
    async ensName(address) {
      const name = await eth.getEnsName({ address });
      if (!name) return null;
      // A reverse record anyone can claim: it counts only when the name resolves back to the address.
      const forward = await eth.getEnsAddress({ name: normalize(name) });
      return forward && forward.toLowerCase() === address.toLowerCase() ? name : null;
    },
    async ensAvatar(name) {
      return eth.getEnsAvatar({ name: normalize(name) });
    },
  };
  return real;
}
