import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AgeStore } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Age storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Postgres through the service role (migration 0005_age_confirmations.sql). */
export const supabaseAgeStore: AgeStore = {
  async get(authority) {
    const { data, error } = await db().from("age_confirmations").select("confirmed_at").eq("authority", authority).maybeSingle();
    if (error) throw new Error(`Age read failed: ${error.message}`);
    return data?.confirmed_at ?? null;
  },
  async confirm(authority, at) {
    const { error } = await db().from("age_confirmations").upsert({ authority, confirmed_at: at }, { onConflict: "authority", ignoreDuplicates: true });
    if (error) throw new Error(`Age save failed: ${error.message}`);
  },
};
