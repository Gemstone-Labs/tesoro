import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { UsageStore } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Sponsor storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`Sponsor ${what} failed: ${error.message}`);
};

async function take(key: string, cost: number, max: number | null, windowMs: number | null): Promise<number> {
  const { data, error } = await db().rpc("sponsor_take", { p_key: key, p_cost: cost, p_max: max, p_window_ms: windowMs });
  fail("counter", error);
  return Number(data);
}

/** Postgres through the service role (migration 0011_sponsor.sql). */
export const supabaseUsageStore: UsageStore = {
  async take(key, cost, max, windowMs) {
    return (await take(key, cost, max, windowMs)) >= 0;
  },
  async refund(key, cost) {
    await take(key, -cost, null, null);
  },
  async add(key, cost, windowMs) {
    return take(key, cost, null, windowMs);
  },
  async used(key, windowMs) {
    return take(key, 0, null, windowMs);
  },
  async hold(key, lamports) {
    const { data, error } = await db().from("sponsor_hold").upsert({ key, lamports: lamports.toString() }, { onConflict: "key", ignoreDuplicates: true }).select("key");
    fail("hold", error);
    return (data?.length ?? 0) > 0;
  },
  async release(key) {
    const { data, error } = await db().from("sponsor_hold").delete().eq("key", key).select("lamports");
    fail("release", error);
    return data?.length ? BigInt(data[0].lamports) : 0n;
  },
  async held() {
    const { data, error } = await db().from("sponsor_hold").select("lamports");
    fail("held", error);
    return (data ?? []).reduce((sum, r) => sum + BigInt(r.lamports), 0n);
  },
};
