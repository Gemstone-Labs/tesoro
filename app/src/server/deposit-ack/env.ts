import { MemoryDepositAckStore, type DepositAckStore } from "./store";
import { supabaseDepositAckStore } from "./supabase-store";

const shared = globalThis as { tesoroDepositAckMemory?: MemoryDepositAckStore };

/** Supabase when it is configured; in local dev without it, one in-memory store per server process (on globalThis, so every route shares it). */
export function depositAckStore(env: Record<string, string | undefined> = process.env, configured: DepositAckStore = supabaseDepositAckStore): DepositAckStore {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return configured;
  if (env.NODE_ENV === "production") throw new Error("Deposit acknowledgment storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return (shared.tesoroDepositAckMemory ??= new MemoryDepositAckStore());
}
