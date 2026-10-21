import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Rpc } from "./rpc";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Match history storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Calls the Postgres functions of migration 0007_match_history.sql through the service role. */
export const supabaseRpc: Rpc = async (fn, args) => {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`Match history ${fn} failed: ${error.message}`);
  return data;
};
