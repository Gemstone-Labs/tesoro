import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DepositAckStore } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Deposit acknowledgment storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Postgres through the service role (migration 0009_deposit_acknowledgments.sql). */
export const supabaseDepositAckStore: DepositAckStore = {
  async get(authority, version) {
    const { data, error } = await db().from("deposit_acknowledgments").select("acknowledged_at").eq("authority", authority).eq("version", version).maybeSingle();
    if (error) throw new Error(`Deposit acknowledgment read failed: ${error.message}`);
    return data?.acknowledged_at ?? null;
  },
  async confirm(authority, version, at) {
    const { error } = await db()
      .from("deposit_acknowledgments")
      .upsert({ authority, version, acknowledged_at: at }, { onConflict: "authority,version", ignoreDuplicates: true });
    if (error) throw new Error(`Deposit acknowledgment save failed: ${error.message}`);
  },
};
