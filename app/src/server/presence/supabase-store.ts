import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PresenceStore } from "./lease";
import { MemoryPresenceStore } from "./lease";

let client: SupabaseClient | undefined;

function db(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const memory = new MemoryPresenceStore();

/** Postgres through the service role (migration 0012_queue_presence.sql); in memory when Supabase is not configured and this is not production. */
export const presenceStore: PresenceStore = {
  async touch(matchKey, at) {
    const c = db();
    if (!c) {
      if (process.env.NODE_ENV === "production") throw new Error("Presence storage is not configured.");
      return memory.touch(matchKey, at);
    }
    const { error } = await c.from("queue_presence").upsert({ match_key: matchKey, seen_at: at }, { onConflict: "match_key" });
    if (error) throw new Error(`Presence save failed: ${error.message}`);
  },
  async rows(matchKeys) {
    const c = db();
    if (!c) {
      if (process.env.NODE_ENV === "production") throw new Error("Presence storage is not configured.");
      return memory.rows(matchKeys);
    }
    const { data, error } = await c.from("queue_presence").select("match_key,seen_at").in("match_key", matchKeys);
    if (error) throw new Error(`Presence read failed: ${error.message}`);
    return data ?? [];
  },
};
