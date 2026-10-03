import { Connection, PublicKey, type AccountInfo, type Commitment, type ConnectionConfig, type GetProgramAccountsConfig } from "@solana/web3.js";
import { GPA_ROUTE } from "./rpc-config";

type Row = { pubkey: PublicKey; account: AccountInfo<Buffer> };
export type GpaFn = (programId: PublicKey, config?: GetProgramAccountsConfig | Commitment) => Promise<Row[]>;

/**
 * A Connection whose getProgramAccounts goes elsewhere (the server list route in the browser, the
 * keeper's list RPC in the keeper) while every other call keeps using the primary endpoint.
 */
export class SplitConnection extends Connection {
  private readonly gpa: GpaFn;
  constructor(endpoint: string, gpa: GpaFn, config?: ConnectionConfig | Commitment) {
    super(endpoint, config);
    this.gpa = gpa;
  }
  // Loosely typed so the override stays assignable to Connection's overload set (the plain, unwrapped form).
  override getProgramAccounts: any = (programId: PublicKey, config?: GetProgramAccountsConfig | Commitment): Promise<Row[]> => this.gpa(programId, config);
}

const recent = new Map<string, { at: number; p: Promise<Row[]> }>();
const SHARE_MS = 1500;

/** Browser gpa: one fetch per distinct query per 1.5s (the Lobby asks for the same list several times). */
export const routeGpa: GpaFn = (programId, config) => {
  const cfg = typeof config === "string" || !config ? {} : config;
  const params = new URLSearchParams({ program: programId.toBase58() });
  for (const f of cfg.filters ?? []) {
    if ("dataSize" in f) params.append("filter", `s:${f.dataSize}`);
    else params.append("filter", `m:${f.memcmp.offset}:${f.memcmp.bytes}`);
  }
  if (cfg.dataSlice) params.set("slice", `${cfg.dataSlice.offset}:${cfg.dataSlice.length}`);
  const key = params.toString();
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.p;
  const p = (async () => {
    const res = await fetch(`${GPA_ROUTE}?${key}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `List query failed (${res.status})`);
    }
    const rows = (await res.json()) as { pubkey: string; account: { data: [string, string]; lamports: number; owner: string; executable: boolean; rentEpoch?: number } }[];
    return rows.map((r) => ({
      pubkey: new PublicKey(r.pubkey),
      account: {
        data: Buffer.from(r.account.data[0], "base64"),
        lamports: r.account.lamports,
        owner: new PublicKey(r.account.owner),
        executable: r.account.executable,
        rentEpoch: r.account.rentEpoch,
      },
    }));
  })();
  recent.set(key, { at: Date.now(), p });
  p.catch(() => recent.delete(key));
  return p;
};
