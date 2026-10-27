import { MemoryAgeStore, type AgeStore } from "./store";
import { supabaseAgeStore } from "./supabase-store";

const shared = globalThis as { tesoroAgeMemory?: MemoryAgeStore };

/** Supabase when it is configured; in local dev without it, one in-memory store per server process (on globalThis, so every route shares it). */
export function ageStore(env: Record<string, string | undefined> = process.env, configured: AgeStore = supabaseAgeStore): AgeStore {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return configured;
  if (env.NODE_ENV === "production") throw new Error("Age storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return (shared.tesoroAgeMemory ??= new MemoryAgeStore());
}
