import "server-only";
import { Connection } from "@solana/web3.js";
import { matchAddressOf, parseMatchKey } from "@/lib/chain/match-id";
import { supabaseRpc } from "@/server/history/db";
import { endStateOf } from "@/server/history/end-state";
import { matchPage } from "@/server/history/reads";
import { configuredRpc, seasonWinsOf } from "@/server/history/season-wins";
import { baseRpc } from "@/lib/chain/rpc-config";
import { runsFromEndState } from "@/server/admin/runs";
import type { RunBatches, SeasonInput } from "@/lib/review/flags";

/** Matches per Season whose run logs are read: the most recent. Keeps one review to a few database calls. */
const MAX_MATCHES_PER_SEASON = 400;

/**
 * The batch cadence of each Block Burst run, from the end states the keeper stores in the Match history (ticket 33): the
 * table is reused, so the Board accounts the old Matches kept are gone. Matches of other Games, and ones with no kept log,
 * give nothing.
 */
async function loadRuns(matchIds: string[]): Promise<RunBatches[]> {
  const runs: RunBatches[] = [];
  for (let i = 0; i < matchIds.length; i += 25) {
    const batch = await Promise.all(
      matchIds.slice(i, i + 25).map(async (id) => {
        const key = parseMatchKey(id);
        const address = matchAddressOf(id);
        if (!key || !address) return [];
        const [stored, page] = await Promise.all([endStateOf(supabaseRpc, address.toBase58()), matchPage(supabaseRpc, key)]);
        if (!stored || stored.state.game !== "block-puzzle" || !page?.sides[1]) return [];
        return runsFromEndState(id, [page.sides[0].player, page.sides[1].player], stored.state);
      }),
    );
    runs.push(...batch.flat());
  }
  return runs;
}

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" }));

/** Public chain reads for the given Seasons: their wins and the Block Burst runs of those Matches. */
export async function loadSeasons(seasons: number[]): Promise<SeasonInput[]> {
  const c = connection();
  return Promise.all(
    seasons.map(async (season) => {
      const wins = await seasonWinsOf(c, season, await configuredRpc());
      const recent = [...wins].sort((a, b) => b.ts - a.ts).slice(0, MAX_MATCHES_PER_SEASON).map((w) => w.matchId);
      return { season, wins, runs: await loadRuns(recent) };
    }),
  );
}
