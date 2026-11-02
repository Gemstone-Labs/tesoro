import { AsyncLocalStorage } from "node:async_hooks";
import { PublicKey, type AccountInfo, type GetProgramAccountsConfig } from "@solana/web3.js";

/** Helius credits per RPC method. Everything not listed costs 1. One table, so a plan change is one edit. */
const CREDIT_WEIGHTS: Record<string, number> = {
  getProgramAccounts: 10,
};

export const creditsOf = (method: string) => CREDIT_WEIGHTS[method] ?? 1;

const PASS = "(pass)";

/** Counts RPC calls by method and by the job that made them, and prices them in credits. */
export class CreditMeter {
  private methods = new Map<string, { calls: number; credits: number }>();
  private jobs = new Map<string, number>();
  private readonly job = new AsyncLocalStorage<string>();

  record(method: string) {
    const credits = creditsOf(method);
    const m = this.methods.get(method) ?? { calls: 0, credits: 0 };
    m.calls++;
    m.credits += credits;
    this.methods.set(method, m);
    const job = this.job.getStore() ?? PASS;
    this.jobs.set(job, (this.jobs.get(job) ?? 0) + credits);
  }

  /** Runs `fn`; every call made inside it (however deep, however late) is charged to `name`. */
  inJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.job.run(name, fn);
  }

  byMethod() {
    return Object.fromEntries(this.methods);
  }
  byJob() {
    return Object.fromEntries(this.jobs);
  }
  totalCredits() {
    return [...this.methods.values()].reduce((a, m) => a + m.credits, 0);
  }
  totalCalls() {
    return [...this.methods.values()].reduce((a, m) => a + m.calls, 0);
  }

  /** Log lines for the run so far: one per job (dearest first), then the total. */
  report(): string[] {
    const perJob = [...this.jobs].sort((a, b) => b[1] - a[1]).map(([job, credits]) => `credits ${job} ${credits}`);
    return [...perJob, `credits run total=${this.totalCredits()} calls=${this.totalCalls()}`];
  }

  reset() {
    this.methods.clear();
    this.jobs.clear();
  }
}

/** The one meter of the keeper. */
export const meter = new CreditMeter();

export const refusedOnMainnet = () =>
  new Error("getProgramAccounts is refused on mainnet (10 credits a call, no paging): use scanProgramAccounts (getProgramAccountsV2) from keeper/src/credits.ts");

const methodsOf = (body: unknown): string[] => {
  if (typeof body !== "string") return [];
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => r?.method).filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
};

/** Wraps a fetch so every JSON-RPC request is counted, and a plain getProgramAccounts is refused on mainnet before it is sent. */
export function meteredFetch(inner: typeof fetch, meter: CreditMeter, opts: { mainnet: () => boolean }): typeof fetch {
  return (async (input: any, init?: any) => {
    const methods = methodsOf(init?.body);
    if (methods.includes("getProgramAccounts") && opts.mainnet()) throw refusedOnMainnet();
    for (const m of methods) meter.record(m);
    return inner(input, init);
  }) as typeof fetch;
}

type Row = { pubkey: PublicKey; account: AccountInfo<Buffer> };

export interface ScanOptions {
  filters?: GetProgramAccountsConfig["filters"];
  dataSlice?: { offset: number; length: number };
  /** Helius only: skip accounts not written since this slot. Ignored by the plain fallback, which returns everything. */
  changedSinceSlot?: number;
  /** Accounts per page (V2). */
  limit?: number;
}

/** What a scan needs from an RPC; `makeScanRpc` builds it from a real endpoint. */
export interface ScanRpc {
  /** Whether the endpoint serves getProgramAccountsV2. */
  helius: boolean;
  call(method: string, params: unknown[]): Promise<any>;
  getProgramAccounts(programId: PublicKey, config?: GetProgramAccountsConfig): Promise<Row[]>;
}

export const isHelius = (endpoint: string) => /(^|\.)helius(-rpc)?\.(com|xyz)$/.test(new URL(endpoint).hostname);

/** All accounts of a program matching the filters, read with paginated getProgramAccountsV2; plain getProgramAccounts where the RPC has no V2. */
export async function scanProgramAccounts(rpc: ScanRpc, programId: PublicKey, opts: ScanOptions = {}): Promise<Row[]> {
  if (!rpc.helius) return rpc.getProgramAccounts(programId, { commitment: "confirmed", filters: opts.filters, dataSlice: opts.dataSlice });
  const rows: Row[] = [];
  let paginationKey: string | undefined;
  do {
    const config: Record<string, unknown> = { encoding: "base64", commitment: "confirmed", limit: opts.limit ?? 1000 };
    if (opts.filters) config.filters = opts.filters;
    if (opts.dataSlice) config.dataSlice = opts.dataSlice;
    if (opts.changedSinceSlot !== undefined) config.changedSinceSlot = opts.changedSinceSlot;
    if (paginationKey) config.paginationKey = paginationKey;
    const page = await rpc.call("getProgramAccountsV2", [programId.toBase58(), config]);
    for (const r of page.accounts as { pubkey: string; account: { data: [string, string]; lamports: number; owner: string; executable: boolean; rentEpoch?: number } }[]) {
      rows.push({
        pubkey: new PublicKey(r.pubkey),
        account: { data: Buffer.from(r.account.data[0], "base64"), lamports: r.account.lamports, owner: new PublicKey(r.account.owner), executable: r.account.executable, rentEpoch: r.account.rentEpoch },
      });
    }
    paginationKey = page.paginationKey ?? undefined;
  } while (paginationKey);
  return rows;
}

/** A ScanRpc over an endpoint: JSON-RPC posts go through `fetchFn` (the metered fetch), plain scans through `getProgramAccounts`. */
export function makeScanRpc(endpoint: string, fetchFn: typeof fetch, getProgramAccounts: ScanRpc["getProgramAccounts"]): ScanRpc {
  return {
    helius: isHelius(endpoint),
    getProgramAccounts,
    async call(method, params) {
      const res = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }) });
      const json = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    },
  };
}
