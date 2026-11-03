import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { GameId } from "@/lib/mock/types";
import type { LeaseStore } from "./assign";
import type { TablePick } from "./assign-ix";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Table leases are not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`Table ${what} failed: ${error.message}`);
};

/** The keeper republishes the pool every pass; rows older than this are from a keeper that stopped, so nothing is assigned from them. */
export const POOL_FRESH_MS = 2 * 60_000;

/** Postgres through the service role (migration 0021_table_leases.sql). */
export const supabaseLeaseStore: LeaseStore = {
  async take(key, holder, ttlMs) {
    const { data, error } = await db().rpc("take_table_lease", { p_key: key, p_holder: holder, p_ttl_ms: ttlMs });
    fail("lease", error);
    return data === true;
  },
  async extend(key, holder, ttlMs) {
    fail("lease", (await db().rpc("extend_table_lease", { p_key: key, p_holder: holder, p_ttl_ms: ttlMs })).error);
  },
  async release(key, holder) {
    fail("lease", (await db().rpc("release_table_lease", { p_key: key, p_holder: holder })).error);
  },
};

/** The tables the keeper last published as ready for `game`. */
export async function supabasePoolTables(game: GameId, now = Date.now()): Promise<TablePick[]> {
  const since = new Date(now - POOL_FRESH_MS).toISOString();
  const { data, error } = await db().from("table_pool").select("generation, idx, epoch").eq("game", game).gte("updated_at", since);
  fail("pool", error);
  return (data ?? []).map((r) => ({ generation: Number(r.generation), index: Number(r.idx), epoch: BigInt(r.epoch) }));
}
