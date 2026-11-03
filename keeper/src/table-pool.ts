import { PublicKey } from "@solana/web3.js";
import { gameOfProgram } from "../../app/src/lib/chain/games.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { historyRpc } from "./history.ts";
import type { GameAdapter, PoolTable } from "./scheduler.ts";

/**
 * Publishes what a rollup read showed to `table_pool` (migrations 0021 and 0023): the tables able to take a Match, with their live
 * epoch, read at `readAtMs`. The sponsor server keeps the pool between reads (it claims a table when it assigns a Match and the
 * history frees it when the Match settles); this read corrects any drift. Only the keeper can read a table's live epoch.
 */
export const poolPublisher = (rpc: Rpc) => async (a: GameAdapter, tables: PoolTable[], readAtMs: number): Promise<void> => {
  const game = gameOfProgram(new PublicKey(a.programId));
  if (!game) return;
  await rpc("publish_table_pool", { p_game: game, p_tables: tables.map((t) => ({ generation: t.generation, index: t.index, epoch: String(t.epoch) })), p_read_at: new Date(readAtMs).toISOString() });
};

/** The publisher named by the environment (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY), or undefined when no database is configured. */
export function poolPublisherFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const rpc = historyRpc(env);
  return rpc ? poolPublisher(rpc) : undefined;
}
