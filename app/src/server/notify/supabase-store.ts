import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NotifyRecord, NotifyStore } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Notification storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`Notify ${what} failed: ${error.message}`);
};

/** Postgres through the service role (migration 0002_notify.sql). */
export const supabaseNotifyStore: NotifyStore = {
  async get(authority) {
    const { data, error } = await db().from("notify_settings").select("email, verified, enabled, sent_day, sent_today, digest").eq("authority", authority).maybeSingle();
    fail("read", error);
    if (!data) return null;
    return { email: data.email, verified: data.verified, enabled: data.enabled, sentDay: data.sent_day, sentToday: data.sent_today, digest: data.digest ?? [] } satisfies NotifyRecord;
  },
  async saveEmail(authority, email, token) {
    const { error } = await db()
      .from("notify_settings")
      .upsert({ authority, email, verified: false, verify_token: token, verify_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "authority" });
    fail("save", error);
  },
  async verify(token) {
    const { data, error } = await db()
      .from("notify_settings")
      .update({ verified: true, verify_token: null, updated_at: new Date().toISOString() })
      .eq("verify_token", token)
      .select("authority")
      .maybeSingle();
    fail("verify", error);
    return data?.authority ?? null;
  },
  async setEnabled(authority, enabled) {
    const { error } = await db().from("notify_settings").update({ enabled, updated_at: new Date().toISOString() }).eq("authority", authority);
    fail("update", error);
  },
  async claimEvent(id, authority) {
    const { error } = await db().from("notify_events").insert({ event_id: id, authority });
    if (error?.code === "23505") return false;
    fail("claim", error);
    return true;
  },
  async releaseEvent(id) {
    const { error } = await db().from("notify_events").delete().eq("event_id", id);
    fail("release", error);
  },
  async recordSent(authority, day) {
    const r = await this.get(authority);
    const { error } = await db()
      .from("notify_settings")
      .update({ sent_day: day, sent_today: r?.sentDay === day ? r.sentToday + 1 : 1 })
      .eq("authority", authority);
    fail("count", error);
  },
  async addDigest(authority, _day, message) {
    const r = await this.get(authority);
    const { error } = await db()
      .from("notify_settings")
      .update({ digest: [...(r?.digest ?? []), message] })
      .eq("authority", authority);
    fail("digest", error);
  },
};
