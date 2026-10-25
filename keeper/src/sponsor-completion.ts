import { completionStore, recoverCompletions, type CompletionStore } from "../../app/src/server/sponsor/completion.ts";
import { log, type Ctx } from "./act.ts";
import { recoverObservedCompletions, type ObservationChain, type ObservationStore } from "../../app/src/server/sponsor/observed-completion.ts";

export function keeperCompletionStore(env: NodeJS.ProcessEnv = process.env): (CompletionStore & ObservationStore) | null {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url && !key && env.KEEPER_KEYS_FROM_ENV !== "1") return null;
  if (!url || !key) throw new Error("Sponsor completion requires the persistent database configuration");
  return completionStore(async (name, args) => {
    const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` }, body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Sponsor ${name} failed: HTTP ${response.status}`);
    return response.json();
  });
}

/** Recovers even when a closed Match/Ticket no longer appears in the keeper's account inventory. */
export async function sponsorCompletionJob(ctx: Ctx): Promise<number> {
  if (ctx.settings.dryRun) return 0;
  const store = keeperCompletionStore();
  if (!store) return 0;
  const chain: ObservationChain = {
    getTransaction: (signature, options) => ctx.conn.getTransaction(signature, options),
    getSignaturesForAddress: (address, options, commitment) => ctx.conn.getSignaturesForAddress(address, options, commitment),
    blockSignatures: async (slot) => {
      const block = await ctx.conn.getBlock(slot, { commitment: "finalized", maxSupportedTransactionVersion: 0, rewards: false });
      return block?.transactions.map((t) => t.transaction.signatures[0]) ?? null;
    },
  };
  const done = await recoverCompletions(store, ctx.conn) + await recoverObservedCompletions(store, chain);
  if (done) log("sponsor", "-", `reconciled ${done} finalized transaction(s)`);
  return done;
}
