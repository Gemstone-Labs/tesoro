import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Waitlist storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/**
 * Adds an email and returns its spot: how many joined up to and including it. A duplicate is a
 * success with the original spot, so the form never reveals who is already listed.
 */
export async function join(
  email: string,
  meta: { source?: string | null; referrer?: string | null; roles?: string[]; studio?: string | null },
): Promise<number | null> {
  const { error } = await db()
    .from("waitlist")
    .upsert(
      { email, source: meta.source ?? null, referrer: meta.referrer ?? null, roles: meta.roles ?? [], studio: meta.studio ?? null },
      { onConflict: "email", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Waitlist insert failed: ${error.message}`);
  const { data: row } = await db().from("waitlist").select("id").eq("email", email).maybeSingle();
  if (!row) return null;
  const { count: spot } = await db().from("waitlist").select("*", { count: "exact", head: true }).lte("id", row.id);
  return spot ?? null;
}

/** Players on the list, or null when storage is unavailable. The page revalidates every 60 s, which caches this. */
export async function count(): Promise<number | null> {
  try {
    const { count: n, error } = await db().from("waitlist").select("*", { count: "exact", head: true });
    return error ? null : n;
  } catch {
    return null;
  }
}
