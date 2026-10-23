import type { Connection } from "@solana/web3.js";
import { fetchSeasonWins } from "@/lib/chain/leaderboard";
import type { Win } from "@/lib/chain/season";
import { seasonWins } from "./reads";
import type { Rpc } from "./rpc";

/**
 * A Season's wins for the Leaderboard. The Match history has them all (it is fed by every `MatchWon`
 * the keeper sees); without a history database (a dev machine) the `MatchWon` events are read off the chain,
 * which is slower and walks every transaction of the Season.
 */
export async function seasonWinsOf(conn: Connection, season: number, rpc: Rpc | null, scan: typeof fetchSeasonWins = fetchSeasonWins): Promise<Win[]> {
  if (rpc) {
    try {
      return await seasonWins(rpc, season);
    } catch (e) {
      console.warn("season wins from the history failed; scanning the chain", e);
    }
  }
  return scan(conn, season);
}

/** The history database's client when it is configured, else null. */
export async function configuredRpc(): Promise<Rpc | null> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return (await import("./db")).supabaseRpc;
}
