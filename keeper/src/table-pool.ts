import { PublicKey } from "@solana/web3.js";
import { gameOfProgram } from "../../app/src/lib/chain/games.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { historyRpc } from "./history.ts";
import type { GameAdapter, PoolTable } from "./scheduler.ts";

/**
 * Publishes the tables that can take a Match to `table_pool` (migration 0020), replacing the Game's rows. The sponsor server
 * assigns a joining Player's Match from this pool in the join's own transaction; only the keeper can read a table's live epoch.
 */
export const poolPublisher = (rpc: Rpc) => async (a: GameAdapter, tables: PoolTable[]): Promise<void> => {
  const game = gameOfProgram(new PublicKey(a.programId));
  if (!game) return;
  await rpc("publish_table_pool", { p_game: game, p_tables: tables.map((t) => ({ generation: t.generation, index: t.index, epoch: String(t.epoch) })) });
};

/** The publisher named by the environment (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY), or undefined when no database is configured. */
export function poolPublisherFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const rpc = historyRpc(env);
  return rpc ? poolPublisher(rpc) : undefined;
}
