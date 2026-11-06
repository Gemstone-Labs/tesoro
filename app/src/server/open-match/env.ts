import "server-only";
import { supabaseRpc } from "../history/db";
import { pruneOpenMatches, rpcTrackTxStore, trackPending } from "./pass";
import { rpcOpenMatchStore } from "./store";

/** The production wiring of the open-Match tracking over the stored webhook transactions. */
export function openMatchPasses() {
  const matches = rpcOpenMatchStore(supabaseRpc);
  return {
    pending: () => trackPending({ txs: rpcTrackTxStore(supabaseRpc), matches, warn: (m) => console.warn("open-match", m) }),
    prune: async () => ({ pruned: await pruneOpenMatches(matches) }),
  };
}
