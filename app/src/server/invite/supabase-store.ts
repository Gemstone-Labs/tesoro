import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ClaimResult, InviteStore } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Invite storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`Invite ${what} failed: ${error.message}`);
};

/** Postgres through the service role (migration 0003_invites.sql). */
export const supabaseInviteStore: InviteStore = {
  async create(codeHash, email) {
    const { error } = await db().from("invites").insert({ code_hash: codeHash, email });
    fail("create", error);
  },
  async claim(codeHash, authority): Promise<ClaimResult> {
    // One statement: only an unused row matches, so two wallets cannot both win.
    const won = await db()
      .from("invites")
      .update({ used_at: new Date().toISOString(), used_by_authority: authority })
      .eq("code_hash", codeHash)
      .is("used_by_authority", null)
      .select("email")
      .maybeSingle();
    fail("claim", won.error);
    if (won.data) return { state: "claimed", email: won.data.email };
    const row = await db().from("invites").select("email, used_by_authority").eq("code_hash", codeHash).maybeSingle();
    fail("read", row.error);
    if (!row.data) return { state: "unknown" };
    return row.data.used_by_authority === authority ? { state: "same", email: row.data.email } : { state: "other" };
  },
};
